package connection

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/edge-connector-gui/internal/config"
)

const maxMessageBytes = 16 << 20

type MCP interface {
	Handle(context.Context, json.RawMessage) (json.RawMessage, error)
}

type Envelope struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Email     string          `json:"email,omitempty"`
	DeviceID  string          `json:"deviceId,omitempty"`
	Payload   json.RawMessage `json:"payload"`
}

type route struct {
	MCPID   string          `json:"mcpId"`
	Message json.RawMessage `json:"message"`
}

type Manager struct {
	Config config.Config
	MCP    MCP
	Logger *slog.Logger
}

type socket struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *socket) send(m Envelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.conn.WriteJSON(m)
}

func message(kind, id string, payload any, cfg config.Config) Envelope {
	b, _ := json.Marshal(payload)
	return Envelope{Version: 1, Type: kind, RequestID: id, Email: cfg.Email, DeviceID: cfg.DeviceID, Payload: b}
}

func requestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("cryptographic randomness unavailable")
	}
	return hex.EncodeToString(b[:])
}

func dialURL(raw string) string {
	u, err := url.Parse(raw)
	if err == nil && u.Scheme == "ws" && u.Hostname() == "localhost" {
		port := u.Port()
		if port == "" {
			port = "80"
		}
		u.Host = net.JoinHostPort("127.0.0.1", port)
		return u.String()
	}
	return raw
}

func (m *Manager) logger() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

func (m *Manager) Run(ctx context.Context) error {
	if m.MCP == nil {
		return errors.New("MCP host required")
	}
	delay := time.Second
	for ctx.Err() == nil {
		conn, _, err := (&websocket.Dialer{HandshakeTimeout: 10 * time.Second}).DialContext(ctx, dialURL(m.Config.ServerURL), nil)
		if err == nil {
			m.logger().Info("WebSocket connected")
			err = m.session(ctx, conn)
			_ = conn.Close()
		}
		if ctx.Err() != nil {
			break
		}
		m.logger().Warn("GUI Edge connection lost; reconnecting", "errorType", fmt.Sprintf("%T", err), "delay", delay.String())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
	return nil
}

func (m *Manager) session(ctx context.Context, conn *websocket.Conn) error {
	conn.SetReadLimit(maxMessageBytes)
	s := &socket{conn: conn}
	id := requestID()
	if err := s.send(message("edge.register", id, map[string]string{"mcpId": config.MCPID}, m.Config)); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var ack Envelope
	if err := conn.ReadJSON(&ack); err != nil {
		return err
	}
	if ack.Version != 1 || ack.Type != "edge.registered" || ack.RequestID != id {
		return errors.New("GUI Edge registration rejected")
	}
	var registered struct {
		ConnectionID string `json:"connectionId"`
		MCPID        string `json:"mcpId"`
	}
	if json.Unmarshal(ack.Payload, &registered) != nil || registered.ConnectionID == "" || registered.MCPID != config.MCPID {
		return errors.New("invalid GUI Edge registration acknowledgement")
	}
	_ = conn.SetReadDeadline(time.Time{})
	m.logger().Info("GUI Edge registered", "connectionId", registered.ConnectionID)
	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { <-sessionCtx.Done(); _ = conn.Close() }()
	go m.heartbeat(sessionCtx, s)
	for {
		kind, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if kind != websocket.TextMessage {
			continue
		}
		var envelope Envelope
		if json.Unmarshal(raw, &envelope) != nil || envelope.Version != 1 {
			continue
		}
		switch envelope.Type {
		case "edge.heartbeat_ack":
			m.logger().Info("Heartbeat acknowledged")
		case "mcp.request":
			if err := m.handle(sessionCtx, s, envelope); err != nil {
				return err
			}
		case "edge.error":
			m.logger().Warn("GUI Edge server returned an error")
		}
	}
}

func (m *Manager) heartbeat(ctx context.Context, s *socket) {
	interval := time.Duration(m.Config.HeartbeatSeconds) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.send(message("edge.heartbeat", requestID(), map[string]any{}, m.Config)); err != nil {
				_ = s.conn.Close()
				return
			}
			m.logger().Info("Heartbeat sent")
		}
	}
}

func (m *Manager) handle(ctx context.Context, s *socket, envelope Envelope) error {
	if len(envelope.RequestID) == 0 || len(envelope.RequestID) > 128 ||
		(envelope.Email != "" && !strings.EqualFold(envelope.Email, m.Config.Email)) ||
		(envelope.DeviceID != "" && envelope.DeviceID != m.Config.DeviceID) {
		return nil
	}
	var payload route
	if json.Unmarshal(envelope.Payload, &payload) != nil || payload.MCPID != config.MCPID || !json.Valid(payload.Message) {
		return nil
	}
	var req struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(payload.Message, &req) != nil {
		return nil
	}
	m.logger().Info("MCP request received", "method", req.Method)
	requestCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	result, err := m.MCP.Handle(requestCtx, payload.Message)
	if err != nil {
		m.logger().Error("Local SAP GUI MCP request failed", "errorType", fmt.Sprintf("%T", err))
		if len(req.ID) == 0 {
			return nil
		}
		result, _ = json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID,
			"error": map[string]any{"code": -32603, "message": "Local SAP GUI MCP unavailable; check GUI, scripting and session"}})
	}
	if len(result) == 0 {
		return nil
	}
	return s.send(message("mcp.response", envelope.RequestID, struct {
		Message json.RawMessage `json:"message"`
	}{result}, m.Config))
}

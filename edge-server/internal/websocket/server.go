package websocketserver

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/edge-server/internal/connections"
	"github.com/trueai/edge-server/internal/protocol"
	"github.com/trueai/edge-server/internal/routing"
)

type Server struct {
	Devices *connections.Registry
	Pending *routing.Pending
}

func New() *Server     { return &Server{Devices: connections.New(), Pending: routing.New()} }
func randomID() string { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/ws" && r.URL.Path != "/harness/ws" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	if r.URL.Path == "/ws" {
		s.device(conn)
		return
	}
	s.harness(conn)
}

func read(conn *websocket.Conn) (protocol.Message, error) {
	kind, b, err := conn.ReadMessage()
	if err != nil {
		return protocol.Message{}, err
	}
	if kind != websocket.TextMessage {
		return protocol.Message{}, errors.New("text frame required")
	}
	var m protocol.Message
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.Version != protocol.Version {
		return m, errors.New("unsupported version")
	}
	return m, nil
}

func closePolicy(c *websocket.Conn) {
	_ = c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "invalid message"), time.Now().Add(time.Second))
}

func (s *Server) device(conn *websocket.Conn) {
	conn.SetReadLimit(protocol.MaxControlBytes)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	m, err := read(conn)
	if err != nil || m.Type != "edge.register" || m.RequestID == "" {
		closePolicy(conn)
		return
	}
	email := strings.TrimSpace(m.Email)
	if email == "" || m.DeviceID == "" {
		closePolicy(conn)
		return
	}
	d := &connections.Device{Email: email, DeviceID: m.DeviceID, ConnectionID: "conn-" + randomID(), Conn: conn}
	if old := s.Devices.Register(d); old != nil {
		slog.Info("Edge connection replaced", "email", email, "oldConnectionId", old.ConnectionID, "connectionId", d.ConnectionID)
	} else {
		slog.Info("Edge connection registered", "email", email, "connectionId", d.ConnectionID)
	}
	defer func() {
		s.Devices.Remove(d)
		slog.Info("Edge connection closed", "email", email, "connectionId", d.ConnectionID)
	}()
	if d.Send(protocol.New("edge.registered", m.RequestID, map[string]string{"connectionId": d.ConnectionID})) != nil {
		return
	}
	conn.SetReadLimit(protocol.MaxRPCBytes)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(75 * time.Second))
		m, err = read(conn)
		if err != nil {
			return
		}
		switch m.Type {
		case "edge.heartbeat":
			var p struct {
				DeviceID string `json:"deviceId"`
			}
			if json.Unmarshal(m.Payload, &p) != nil || p.DeviceID != d.DeviceID {
				closePolicy(conn)
				return
			}
			if d.Send(protocol.New("edge.heartbeat_ack", "", map[string]string{"serverTime": time.Now().UTC().Format(time.RFC3339Nano)})) != nil {
				return
			}
		case "edge.mcp.response":
			if m.RequestID == "" || !s.Pending.Resolve(m.RequestID, d.ConnectionID, m) {
				closePolicy(conn)
				return
			}
		case "edge.disconnect":
			return
		default:
			closePolicy(conn)
			return
		}
	}
}

func (s *Server) harness(conn *websocket.Conn) {
	conn.SetReadLimit(protocol.MaxRPCBytes)
	for {
		m, err := read(conn)
		if err != nil {
			return
		}
		if m.Type != "harness.mcp.request" || m.RequestID == "" {
			closePolicy(conn)
			return
		}
		var route protocol.Route
		if json.Unmarshal(m.Payload, &route) != nil || strings.TrimSpace(route.Email) == "" || route.MCPID == "" || !json.Valid(route.Message) {
			closePolicy(conn)
			return
		}
		d, err := s.Devices.Get(strings.TrimSpace(route.Email))
		if err != nil {
			if conn.WriteJSON(protocol.New("harness.mcp.error", m.RequestID, map[string]string{"error": "device offline"})) != nil {
				return
			}
			continue
		}
		id := randomID()
		result, err := s.Pending.Add(id, d.ConnectionID)
		if err != nil {
			return
		}
		if err = d.Send(protocol.New("edge.mcp.request", id, protocol.Route{MCPID: route.MCPID, Message: route.Message})); err != nil {
			s.Pending.Remove(id)
			if conn.WriteJSON(protocol.New("harness.mcp.error", m.RequestID, map[string]string{"error": "device connection lost"})) != nil {
				return
			}
			continue
		}
		select {
		case response := <-result:
			var payload struct {
				Message json.RawMessage `json:"message"`
			}
			if json.Unmarshal(response.Payload, &payload) != nil || !json.Valid(payload.Message) {
				closePolicy(conn)
				return
			}
			if conn.WriteJSON(protocol.New("harness.mcp.response", m.RequestID, protocol.Route{Message: payload.Message})) != nil {
				return
			}
		case <-time.After(60 * time.Second):
			s.Pending.Remove(id)
			if conn.WriteJSON(protocol.New("harness.mcp.error", m.RequestID, map[string]string{"error": "device response timeout"})) != nil {
				return
			}
		}
	}
}

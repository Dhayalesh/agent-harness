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
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type State string

const (
	Disconnected State = "DISCONNECTED"
	Connecting   State = "CONNECTING"
	Connected    State = "CONNECTED"
	Registering  State = "REGISTERING"
	Ready        State = "READY"
	Reconnecting State = "RECONNECTING"
	Stopping     State = "STOPPING"
)

type Options struct {
	ServerURL, UserEmail, DeviceID                 string
	HeartbeatInterval, AckTimeout, RegisterTimeout time.Duration
	Logger                                         *slog.Logger
	OnState                                        func(State)
	OnMCP                                          func(context.Context, string, json.RawMessage) json.RawMessage
}

type Manager struct {
	opts  Options
	state State
}

func New(opts Options) *Manager {
	if opts.HeartbeatInterval <= 0 {
		opts.HeartbeatInterval = 30 * time.Second
	}
	if opts.AckTimeout <= 0 {
		opts.AckTimeout = 10 * time.Second
	}
	if opts.RegisterTimeout <= 0 {
		opts.RegisterTimeout = 10 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Manager{opts: opts, state: Disconnected}
}

func (m *Manager) setState(s State) {
	m.state = s
	m.opts.Logger.Info("Edge connection state", "state", s)
	if m.opts.OnState != nil {
		m.opts.OnState(s)
	}
}

func Backoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	if attempt > 5 {
		attempt = 5
	}
	d := time.Second << attempt
	if d > 30*time.Second {
		return 30 * time.Second
	}
	return d
}

func jitteredBackoff(attempt int) time.Duration {
	var random [1]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Backoff(attempt)
	}
	// Spread reconnect attempts over 80-100% of the capped delay.
	return Backoff(attempt) * time.Duration(204+int(random[0])%52) / 255
}

func localDialURL(raw string) string {
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

// Run owns only outbound sockets. It returns after context cancellation.
func (m *Manager) Run(ctx context.Context) error {
	if m.opts.ServerURL == "" || m.opts.UserEmail == "" || m.opts.DeviceID == "" {
		return fmt.Errorf("server, email and device ID are required")
	}
	attempt := 0
	for ctx.Err() == nil {
		m.setState(Connecting)
		dialURL := localDialURL(m.opts.ServerURL)
		target, _ := url.Parse(dialURL)
		m.opts.Logger.Info("WebSocket dialing", "host", target.Host, "path", target.Path)
		conn, response, err := (&websocket.Dialer{HandshakeTimeout: m.opts.RegisterTimeout}).DialContext(ctx, dialURL, nil)
		if err == nil {
			m.opts.Logger.Info("WebSocket handshake completed", "status", response.StatusCode)
			m.setState(Connected)
			err = m.session(ctx, conn, &attempt)
			_ = conn.Close()
		} else if response != nil {
			err = fmt.Errorf("WebSocket HTTP upgrade failed (status %d): %w", response.StatusCode, err)
		} else {
			err = fmt.Errorf("WebSocket dial failed: %w", err)
		}
		if ctx.Err() != nil {
			break
		}
		m.setState(Disconnected)
		var closeErr *websocket.CloseError
		if errors.As(err, &closeErr) {
			m.opts.Logger.Warn("Edge connection lost", "error", err, "closeCode", closeErr.Code, "closeReason", closeErr.Text)
		} else {
			m.opts.Logger.Warn("Edge connection lost", "error", err)
		}
		m.setState(Reconnecting)
		delay := jitteredBackoff(attempt)
		attempt++
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
		}
	}
	m.setState(Stopping)
	m.setState(Disconnected)
	return nil
}

func requestID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (m *Manager) readServerMessage(conn *websocket.Conn) (Message, error) {
	frameType, data, err := conn.ReadMessage()
	if err != nil {
		return Message{}, fmt.Errorf("WebSocket read failed: %w", err)
	}
	m.opts.Logger.Info("Message received from server", "frameType", frameType, "bytes", len(data))
	if frameType != websocket.TextMessage {
		return Message{}, fmt.Errorf("server protocol validation failed: expected JSON text frame, got WebSocket frame type %d", frameType)
	}
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return Message{}, fmt.Errorf("server JSON decode failed: %w", err)
	}
	m.opts.Logger.Info("Message type", "type", msg.Type, "version", msg.Version, "requestId", msg.RequestID)
	return msg, nil
}

func (m *Manager) session(ctx context.Context, conn *websocket.Conn, attempt *int) error {
	conn.SetReadLimit(MaxMessageBytes)
	m.setState(Registering)
	id, err := requestID()
	if err != nil {
		return err
	}
	if err = conn.SetWriteDeadline(time.Now().Add(m.opts.RegisterTimeout)); err != nil {
		return fmt.Errorf("registration write deadline: %w", err)
	}
	m.opts.Logger.Info("Sending edge.register", "requestId", id)
	if err = conn.WriteJSON(Message{Version: Version, Type: "edge.register", RequestID: id, Email: m.opts.UserEmail, DeviceID: m.opts.DeviceID}); err != nil {
		return fmt.Errorf("edge.register write failed: %w", err)
	}
	m.opts.Logger.Info("edge.register sent", "requestId", id)
	if err = conn.SetReadDeadline(time.Now().Add(m.opts.RegisterTimeout)); err != nil {
		return fmt.Errorf("registration read deadline: %w", err)
	}
	m.opts.Logger.Info("Waiting for edge.registered", "requestId", id)
	response, err := m.readServerMessage(conn)
	if err != nil {
		return fmt.Errorf("edge.registered read failed: %w", err)
	}
	if err = validateMessage(response); err != nil {
		return fmt.Errorf("registration protocol validation failed: %w", err)
	}
	if response.Type != "edge.registered" || response.RequestID != id {
		return fmt.Errorf("registration protocol validation failed: expected edge.registered with requestId %s, received type %q requestId %q", id, response.Type, response.RequestID)
	}
	var registered struct {
		ConnectionID string `json:"connectionId"`
	}
	if err = json.Unmarshal(response.Payload, &registered); err != nil {
		return fmt.Errorf("registration payload decode failed: %w", err)
	}
	m.opts.Logger.Info("Message payload", "connectionId", registered.ConnectionID)
	_ = conn.SetReadDeadline(time.Time{})
	conn.SetReadLimit(MaxRPCMessageBytes)
	m.opts.Logger.Info("Registration completed", "connectionId", registered.ConnectionID)
	m.setState(Ready)
	*attempt = 0
	readCh := make(chan error, 1)
	ackCh := make(chan struct{}, 1)
	var writeMu sync.Mutex
	go func() {
		for {
			msg, err := m.readServerMessage(conn)
			if err != nil {
				readCh <- fmt.Errorf("server message read failed: %w", err)
				return
			}
			if msg.Version != Version {
				readCh <- errors.New("unsupported server protocol version")
				return
			}
			if msg.Type == "edge.mcp.request" && m.opts.OnMCP != nil {
				var route MCPRoute
				if msg.RequestID == "" || json.Unmarshal(msg.Payload, &route) != nil || route.MCPID == "" || !json.Valid(route.Message) {
					readCh <- errors.New("invalid edge.mcp.request")
					return
				}
				go func() {
					result := m.opts.OnMCP(ctx, route.MCPID, route.Message)
					if !json.Valid(result) {
						result = json.RawMessage(`null`)
					}
					writeMu.Lock()
					defer writeMu.Unlock()
					_ = conn.SetWriteDeadline(time.Now().Add(m.opts.AckTimeout))
					if err := conn.WriteJSON(newMessage("edge.mcp.response", msg.RequestID, MCPRoute{Message: result})); err != nil {
						select {
						case readCh <- fmt.Errorf("edge.mcp.response write failed: %w", err):
						default:
						}
					}
				}()
				continue
			}
			if err := validateMessage(msg); err != nil {
				readCh <- fmt.Errorf("server message protocol validation failed: %w", err)
				return
			}
			if msg.Type != "edge.heartbeat_ack" {
				readCh <- errors.New("unexpected server message")
				return
			}
			var ack struct {
				ServerTime string `json:"serverTime"`
			}
			_ = json.Unmarshal(msg.Payload, &ack)
			m.opts.Logger.Info("Message payload", "serverTime", ack.ServerTime)
			select {
			case ackCh <- struct{}{}:
			default:
				readCh <- errors.New("unsolicited heartbeat acknowledgement")
				return
			}
		}
	}()
	ticker := time.NewTicker(m.opts.HeartbeatInterval)
	defer ticker.Stop()
	var ackTimer *time.Timer
	var timeout <-chan time.Time
	defer func() {
		if ackTimer != nil {
			ackTimer.Stop()
		}
	}()
	for {
		select {
		case <-ctx.Done():
			m.setState(Stopping)
			writeMu.Lock()
			_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
			_ = conn.WriteJSON(newMessage("edge.disconnect", "", nil))
			writeMu.Unlock()
			return nil
		case err := <-readCh:
			return err
		case <-ticker.C:
			if timeout != nil {
				continue
			}
			writeMu.Lock()
			if err := conn.SetWriteDeadline(time.Now().Add(m.opts.AckTimeout)); err != nil {
				writeMu.Unlock()
				return fmt.Errorf("heartbeat write deadline failed: %w", err)
			}
			m.opts.Logger.Info("Sending heartbeat")
			if err := conn.WriteJSON(newMessage("edge.heartbeat", "", map[string]string{"deviceId": m.opts.DeviceID})); err != nil {
				writeMu.Unlock()
				return fmt.Errorf("heartbeat write failed: %w", err)
			}
			writeMu.Unlock()
			ackTimer = time.NewTimer(m.opts.AckTimeout)
			timeout = ackTimer.C
		case <-ackCh:
			if timeout == nil {
				return errors.New("unsolicited heartbeat acknowledgement")
			}
			if !ackTimer.Stop() {
				select {
				case <-ackTimer.C:
				default:
				}
			}
			timeout = nil
			m.opts.Logger.Info("Heartbeat acknowledged")
		case <-timeout:
			return errors.New("heartbeat acknowledgement timeout")
		}
	}
}

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const MaxMessageBytes = 16 << 20
const MCPID = "sapgui"

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

type peer struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (p *peer) send(m Envelope) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return p.conn.WriteJSON(m)
}

type device struct {
	*peer
	connectionID string
	email        string
	deviceID     string
}

type pending struct {
	client *peer
	edge   *device
	timer  *time.Timer
}

type Server struct {
	mu       sync.Mutex
	devices  map[string]*device
	pending  map[string]*pending
	Timeout  time.Duration
	Logger   *slog.Logger
	upgrader websocket.Upgrader
}

func New(logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{devices: map[string]*device{}, pending: map[string]*pending{}, Timeout: 120 * time.Second,
		Logger: logger, upgrader: websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096}}
}

func makeEnvelope(kind, id string, payload any) Envelope {
	b, _ := json.Marshal(payload)
	return Envelope{Version: 1, Type: kind, RequestID: id, Payload: b}
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("cryptographic randomness unavailable")
	}
	return hex.EncodeToString(b[:])
}

func key(email string) string { return strings.ToLower(strings.TrimSpace(email)) + ":" + MCPID }

func validID(id string) bool { return len(id) > 0 && len(id) <= 128 }

func validMCP(raw json.RawMessage) bool {
	var m struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
	}
	if json.Unmarshal(raw, &m) != nil || m.JSONRPC != "2.0" {
		return false
	}
	switch m.Method {
	case "initialize", "tools/list", "tools/call", "ping":
		if len(m.ID) == 0 || string(m.ID) == "null" || string(m.ID) == "true" || string(m.ID) == "false" {
			return false
		}
		var id any
		if json.Unmarshal(m.ID, &id) != nil {
			return false
		}
		switch id.(type) {
		case string, float64:
		default:
			return false
		}
		if m.Method == "tools/call" {
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if json.Unmarshal(m.Params, &p) != nil || p.Name == "" {
				return false
			}
			if len(p.Arguments) > 0 && p.Arguments[0] != '{' {
				return false
			}
		}
		return true
	case "notifications/initialized":
		return len(m.ID) == 0
	default:
		return false
	}
}

func validMCPResponse(raw json.RawMessage) bool {
	var m struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(raw, &m) != nil || m.JSONRPC != "2.0" || len(m.ID) == 0 ||
		(len(m.Result) == 0 && len(m.Error) == 0) {
		return false
	}
	var id any
	if json.Unmarshal(m.ID, &id) != nil {
		return false
	}
	switch id.(type) {
	case string, float64:
		return true
	default:
		return false
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		if r.Method != http.MethodGet {
			http.Error(w, "GET required", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
		return
	}
	if r.URL.Path != "/ws" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(MaxMessageBytes)
	p := &peer{conn: conn}
	defer func() { s.cleanup(p); _ = conn.Close() }()
	var registered *device
	clientRole := false
	for {
		kind, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if kind != websocket.TextMessage {
			s.error(p, "invalid", "text_required")
			continue
		}
		var m Envelope
		if json.Unmarshal(raw, &m) != nil {
			s.error(p, "invalid", "invalid_json")
			continue
		}
		if m.Version != 1 || !validID(m.RequestID) || len(m.Payload) == 0 || m.Payload[0] != '{' {
			s.error(p, "invalid", "invalid_envelope")
			continue
		}
		switch {
		case m.Type == "edge.register" && registered == nil && !clientRole:
			var payload struct {
				MCPID string `json:"mcpId"`
			}
			if json.Unmarshal(m.Payload, &payload) != nil || payload.MCPID != MCPID ||
				len(strings.TrimSpace(m.Email)) == 0 || len(m.Email) > 254 || len(m.DeviceID) == 0 || len(m.DeviceID) > 128 {
				s.error(p, m.RequestID, "invalid_registration")
				continue
			}
			registered = &device{peer: p, connectionID: randomID(), email: m.Email, deviceID: m.DeviceID}
			s.mu.Lock()
			old := s.devices[key(m.Email)]
			s.devices[key(m.Email)] = registered
			s.mu.Unlock()
			if old != nil {
				_ = old.conn.Close()
			}
			_ = p.send(makeEnvelope("edge.registered", m.RequestID, map[string]string{"connectionId": registered.connectionID, "mcpId": MCPID}))
			s.Logger.Info("GUI device registered", "connectionId", registered.connectionID)
		case m.Type == "edge.heartbeat" && registered != nil:
			_ = p.send(makeEnvelope("edge.heartbeat_ack", m.RequestID, map[string]string{}))
		case m.Type == "mcp.request" && registered == nil:
			clientRole = true
			s.request(p, m)
		case m.Type == "mcp.response" && registered != nil:
			s.response(registered, m)
		default:
			s.error(p, m.RequestID, "unexpected_message")
		}
	}
}

func (s *Server) error(p *peer, id, code string) {
	_ = p.send(makeEnvelope("edge.error", id, map[string]string{"code": code}))
}

func (s *Server) request(client *peer, m Envelope) {
	var payload route
	if json.Unmarshal(m.Payload, &payload) != nil || payload.MCPID != MCPID ||
		len(strings.TrimSpace(m.Email)) == 0 || !validMCP(payload.Message) {
		s.error(client, m.RequestID, "invalid_mcp_request")
		return
	}
	var inner struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal(payload.Message, &inner)
	s.mu.Lock()
	edge := s.devices[key(m.Email)]
	if edge == nil {
		s.mu.Unlock()
		s.error(client, m.RequestID, "device_offline")
		return
	}
	if _, exists := s.pending[m.RequestID]; exists {
		s.mu.Unlock()
		s.error(client, m.RequestID, "duplicate_request_id")
		return
	}
	if inner.Method == "notifications/initialized" {
		s.mu.Unlock()
		forward := makeEnvelope("mcp.request", m.RequestID, payload)
		forward.Email, forward.DeviceID = m.Email, edge.deviceID
		_ = edge.send(forward)
		return
	}
	item := &pending{client: client, edge: edge}
	s.pending[m.RequestID] = item
	item.timer = time.AfterFunc(s.Timeout, func() { s.finish(m.RequestID, item, "timeout", nil) })
	s.mu.Unlock()
	forward := makeEnvelope("mcp.request", m.RequestID, payload)
	forward.Email, forward.DeviceID = m.Email, edge.deviceID
	if err := edge.send(forward); err != nil {
		s.finish(m.RequestID, item, "device_offline", nil)
		return
	}
}

func (s *Server) response(edge *device, m Envelope) {
	var payload struct {
		Message json.RawMessage `json:"message"`
	}
	if json.Unmarshal(m.Payload, &payload) != nil || !validMCPResponse(payload.Message) {
		return
	}
	s.mu.Lock()
	item := s.pending[m.RequestID]
	s.mu.Unlock()
	if item != nil && item.edge == edge {
		s.finish(m.RequestID, item, "", payload.Message)
	}
}

func (s *Server) finish(id string, item *pending, code string, message json.RawMessage) {
	s.mu.Lock()
	if s.pending[id] != item {
		s.mu.Unlock()
		return
	}
	delete(s.pending, id)
	if item.timer != nil {
		item.timer.Stop()
	}
	s.mu.Unlock()
	if code != "" {
		s.error(item.client, id, code)
	} else {
		_ = item.client.send(makeEnvelope("mcp.response", id, struct {
			Message json.RawMessage `json:"message"`
		}{message}))
	}
}

func (s *Server) cleanup(p *peer) {
	s.mu.Lock()
	for k, d := range s.devices {
		if d.peer == p {
			delete(s.devices, k)
		}
	}
	var failures []struct {
		id   string
		item *pending
		edge bool
	}
	for id, item := range s.pending {
		if item.client == p || item.edge.peer == p {
			failures = append(failures, struct {
				id   string
				item *pending
				edge bool
			}{id, item, item.edge.peer == p})
		}
	}
	s.mu.Unlock()
	for _, failure := range failures {
		if failure.edge {
			s.finish(failure.id, failure.item, "device_offline", nil)
		} else {
			s.mu.Lock()
			if s.pending[failure.id] == failure.item {
				delete(s.pending, failure.id)
				if failure.item.timer != nil {
					failure.item.timer.Stop()
				}
			}
			s.mu.Unlock()
		}
	}
}

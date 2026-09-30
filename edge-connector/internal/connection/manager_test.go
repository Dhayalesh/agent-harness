package connection

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testOptions(url string) Options {
	return Options{ServerURL: url, UserEmail: "user@company.com", DeviceID: "edge-12345678901234567890123456789012", HeartbeatInterval: 20 * time.Millisecond, AckTimeout: 70 * time.Millisecond, RegisterTimeout: time.Second, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func testServer(t *testing.T, handler func(*websocket.Conn, int)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	count := new(atomic.Int32)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		handler(c, int(count.Add(1)))
	}))
	return s, count
}

func register(t *testing.T, c *websocket.Conn) Message {
	t.Helper()
	var m Message
	if err := c.ReadJSON(&m); err != nil {
		t.Errorf("read register: %v", err)
		return m
	}
	if m.Version != Version || m.Type != "edge.register" || m.RequestID == "" {
		t.Errorf("bad registration: %+v", m)
	}
	if m.Email != "user@company.com" || m.DeviceID == "" || len(m.Payload) != 0 {
		t.Errorf("bad registration fields: %+v", m)
	}
	return m
}

func reply(c *websocket.Conn, m Message) error {
	return c.WriteJSON(Message{Version: Version, Type: "edge.registered", RequestID: m.RequestID, Payload: json.RawMessage(`{"connectionId":"conn-test"}`)})
}
func ack(c *websocket.Conn) error {
	return c.WriteJSON(Message{Version: Version, Type: "edge.heartbeat_ack", Payload: json.RawMessage(`{"serverTime":"2026-01-01T00:00:00Z"}`)})
}

func runFor(t *testing.T, m *Manager, d time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	if err := m.Run(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRegistrationHeartbeatAndShutdown(t *testing.T) {
	gotHeartbeat := make(chan struct{}, 1)
	gotDisconnect := make(chan struct{}, 1)
	s, _ := testServer(t, func(c *websocket.Conn, _ int) {
		m := register(t, c)
		if err := reply(c, m); err != nil {
			return
		}
		for {
			var msg Message
			if c.ReadJSON(&msg) != nil {
				return
			}
			switch msg.Type {
			case "edge.heartbeat":
				select {
				case gotHeartbeat <- struct{}{}:
				default:
				}
				_ = ack(c)
			case "edge.disconnect":
				gotDisconnect <- struct{}{}
				return
			}
		}
	})
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	m := New(testOptions("ws" + strings.TrimPrefix(s.URL, "http")))
	go func() { done <- m.Run(ctx) }()
	select {
	case <-gotHeartbeat:
	case <-time.After(time.Second):
		t.Fatal("no heartbeat")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown blocked")
	}
	select {
	case <-gotDisconnect:
	case <-time.After(time.Second):
		t.Fatal("disconnect not sent")
	}
}

func TestHeartbeatTimeoutReconnect(t *testing.T) {
	s, count := testServer(t, func(c *websocket.Conn, _ int) {
		m := register(t, c)
		_ = reply(c, m)
		for {
			var msg Message
			if c.ReadJSON(&msg) != nil {
				return
			}
		}
	})
	defer s.Close()
	runFor(t, New(testOptions("ws"+strings.TrimPrefix(s.URL, "http"))), 1300*time.Millisecond)
	if count.Load() < 2 {
		t.Fatalf("expected reconnect after heartbeat timeout, got %d connections", count.Load())
	}
}

func TestDisconnectReconnect(t *testing.T) {
	s, count := testServer(t, func(c *websocket.Conn, n int) {
		m := register(t, c)
		_ = reply(c, m)
		if n == 1 {
			return
		}
		for {
			var msg Message
			if c.ReadJSON(&msg) != nil {
				return
			}
			if msg.Type == "edge.heartbeat" {
				_ = ack(c)
			}
		}
	})
	defer s.Close()
	runFor(t, New(testOptions("ws"+strings.TrimPrefix(s.URL, "http"))), 1300*time.Millisecond)
	if count.Load() < 2 {
		t.Fatalf("expected reconnect, got %d connections", count.Load())
	}
}

func TestInvalidRegistrationAndOversizedMessage(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response Message
	}{
		{"version", Message{Version: 2, Type: "edge.registered", Payload: json.RawMessage(`{"connectionId":"c"}`)}},
		{"missing connection ID", Message{Version: 1, Type: "edge.registered", Payload: json.RawMessage(`{}`)}},
		{"wrong type", Message{Version: 1, Type: "edge.command", Payload: json.RawMessage(`{}`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, count := testServer(t, func(c *websocket.Conn, _ int) {
				m := register(t, c)
				r := tc.response
				r.RequestID = m.RequestID
				_ = c.WriteJSON(r)
				time.Sleep(50 * time.Millisecond)
			})
			defer s.Close()
			var ready atomic.Int32
			o := testOptions("ws" + strings.TrimPrefix(s.URL, "http"))
			o.OnState = func(s State) {
				if s == Ready {
					ready.Add(1)
				}
			}
			runFor(t, New(o), 80*time.Millisecond)
			if count.Load() == 0 || ready.Load() != 0 {
				t.Fatalf("invalid response accepted; connections=%d ready=%d", count.Load(), ready.Load())
			}
		})
	}
	t.Run("oversize", func(t *testing.T) {
		s, _ := testServer(t, func(c *websocket.Conn, _ int) {
			m := register(t, c)
			_ = c.WriteJSON(Message{Version: 1, Type: "edge.registered", RequestID: m.RequestID, Payload: json.RawMessage(`{"connectionId":"` + strings.Repeat("x", MaxMessageBytes) + `"}`)})
		})
		defer s.Close()
		var ready atomic.Int32
		o := testOptions("ws" + strings.TrimPrefix(s.URL, "http"))
		o.OnState = func(s State) {
			if s == Ready {
				ready.Add(1)
			}
		}
		runFor(t, New(o), 80*time.Millisecond)
		if ready.Load() != 0 {
			t.Fatal("oversized registration accepted")
		}
	})
}

func TestBackoff(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for i, w := range want {
		if got := Backoff(i); got != w {
			t.Fatalf("attempt %d: %v want %v", i, got, w)
		}
	}
}

func TestLocalhostDialUsesIPv4(t *testing.T) {
	got := localDialURL("ws://localhost:8080/ws?mode=dev")
	want := "ws://127.0.0.1:8080/ws?mode=dev"
	if got != want {
		t.Fatalf("dial URL = %q, want %q", got, want)
	}
	for _, raw := range []string{"ws://127.0.0.1:8080/ws", "wss://localhost:8080/ws"} {
		if got := localDialURL(raw); got != raw {
			t.Fatalf("dial URL = %q, want unchanged %q", got, raw)
		}
	}
}

func TestInvalidMessageAfterRegistration(t *testing.T) {
	s, _ := testServer(t, func(c *websocket.Conn, _ int) {
		m := register(t, c)
		_ = reply(c, m)
		_ = c.WriteJSON(Message{Version: Version, Type: "edge.execute", Payload: json.RawMessage(`{}`)})
		time.Sleep(100 * time.Millisecond)
	})
	defer s.Close()
	var reconnecting atomic.Int32
	o := testOptions("ws" + strings.TrimPrefix(s.URL, "http"))
	o.OnState = func(s State) {
		if s == Reconnecting {
			reconnecting.Add(1)
		}
	}
	runFor(t, New(o), 150*time.Millisecond)
	if reconnecting.Load() == 0 {
		t.Fatal("invalid server command did not disconnect")
	}
}

func TestRegistrationRequestIDMismatch(t *testing.T) {
	s, _ := testServer(t, func(c *websocket.Conn, _ int) {
		_ = register(t, c)
		_ = c.WriteJSON(Message{Version: Version, Type: "edge.registered", RequestID: "wrong-id", Payload: json.RawMessage(`{"connectionId":"conn-test"}`)})
	})
	defer s.Close()
	var ready atomic.Int32
	o := testOptions("ws" + strings.TrimPrefix(s.URL, "http"))
	o.OnState = func(s State) {
		if s == Ready {
			ready.Add(1)
		}
	}
	runFor(t, New(o), 120*time.Millisecond)
	if ready.Load() != 0 {
		t.Fatal("registration with mismatched request ID was accepted")
	}
}

func TestRoutedMCPRequestUsesOutboundSession(t *testing.T) {
	response := make(chan MCPRoute, 1)
	s, _ := testServer(t, func(c *websocket.Conn, _ int) {
		m := register(t, c)
		_ = reply(c, m)
		_ = c.WriteJSON(newMessage("edge.mcp.request", "route-1", MCPRoute{MCPID: "sap-adt", Message: json.RawMessage(`{"jsonrpc":"2.0","id":"mcp-1","method":"tools/list"}`)}))
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		var got Message
		if c.ReadJSON(&got) == nil && got.Type == "edge.mcp.response" && got.RequestID == "route-1" {
			var p MCPRoute
			if json.Unmarshal(got.Payload, &p) == nil {
				response <- p
			}
		}
	})
	defer s.Close()
	o := testOptions("ws" + strings.TrimPrefix(s.URL, "http"))
	o.HeartbeatInterval = time.Second
	o.OnMCP = func(_ context.Context, mcpID string, msg json.RawMessage) json.RawMessage {
		if mcpID != "sap-adt" || !strings.Contains(string(msg), `"tools/list"`) {
			return nil
		}
		return json.RawMessage(`{"jsonrpc":"2.0","id":"mcp-1","result":{"tools":[]}}`)
	}
	runFor(t, New(o), 150*time.Millisecond)
	select {
	case got := <-response:
		if !strings.Contains(string(got.Message), `"tools":[]`) {
			t.Fatalf("unexpected response: %s", got.Message)
		}
	default:
		t.Fatal("routed MCP response was not sent")
	}
}

package connection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/edge-connector-gui/internal/config"
)

type stubMCP struct{}

func (stubMCP) Handle(_ context.Context, raw json.RawMessage) (json.RawMessage, error) {
	var request struct {
		ID json.RawMessage `json:"id"`
	}
	_ = json.Unmarshal(raw, &request)
	return json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID,
		"result": map[string]any{"content": []any{map[string]string{"type": "image", "data": "YWJj", "mimeType": "image/png"}}}})
}

func TestRegistrationRelayAndReconnect(t *testing.T) {
	var count atomic.Int32
	responses := make(chan Envelope, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var registration Envelope
		if conn.ReadJSON(&registration) != nil || registration.Type != "edge.register" {
			return
		}
		index := count.Add(1)
		ack := message("edge.registered", registration.RequestID, map[string]string{"connectionId": "connected", "mcpId": "sapgui"}, config.Config{})
		if conn.WriteJSON(ack) != nil {
			return
		}
		if index == 1 {
			request := message("mcp.request", "req-1", route{MCPID: "sapgui", Message: json.RawMessage(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)}, config.Config{})
			if conn.WriteJSON(request) != nil {
				return
			}
			var result Envelope
			if conn.ReadJSON(&result) == nil {
				responses <- result
			}
			return // Force reconnect.
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	manager := &Manager{Config: config.Config{ServerURL: "ws" + strings.TrimPrefix(server.URL, "http") + "/ws",
		Email: "gui@example.com", DeviceID: "device", MCPID: "sapgui", HeartbeatSeconds: 5}, MCP: stubMCP{}}
	finished := make(chan error, 1)
	go func() { finished <- manager.Run(ctx) }()
	select {
	case response := <-responses:
		if response.Type != "mcp.response" || response.RequestID != "req-1" {
			t.Fatalf("relay response: %+v", response)
		}
		if !strings.Contains(string(response.Payload), `"mimeType":"image/png"`) {
			t.Fatal("image content lost")
		}
	case <-ctx.Done():
		t.Fatal("response timed out")
	}
	for count.Load() < 2 {
		select {
		case <-ctx.Done():
			t.Fatal("connector did not reconnect")
		case <-time.After(50 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("connector did not stop")
	}
}

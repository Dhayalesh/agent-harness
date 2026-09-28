package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(url, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func receive(t *testing.T, c *websocket.Conn) Envelope {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var result Envelope
	if err := c.ReadJSON(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func register(t *testing.T, edge *websocket.Conn) {
	t.Helper()
	m := makeEnvelope("edge.register", "r1", map[string]string{"mcpId": MCPID})
	m.Email, m.DeviceID = "gui@example.com", "dev-1"
	if err := edge.WriteJSON(m); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, edge); got.Type != "edge.registered" || got.RequestID != "r1" {
		t.Fatalf("registration: %+v", got)
	}
}

func TestHealthAndRelay(t *testing.T) {
	s := New(nil)
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	resp, err := http.Get(httpServer.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("health status %d", resp.StatusCode)
	}
	edge, client := dial(t, httpServer.URL), dial(t, httpServer.URL)
	register(t, edge)
	if err := edge.WriteJSON(makeEnvelope("edge.heartbeat", "hb", map[string]any{})); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, edge); got.Type != "edge.heartbeat_ack" || got.RequestID != "hb" {
		t.Fatalf("heartbeat: %+v", got)
	}
	request := json.RawMessage(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)
	m := makeEnvelope("mcp.request", "m1", route{MCPID: MCPID, Message: request})
	m.Email = "gui@example.com"
	if err := client.WriteJSON(m); err != nil {
		t.Fatal(err)
	}
	forwarded := receive(t, edge)
	if forwarded.Type != "mcp.request" || forwarded.RequestID != "m1" {
		t.Fatalf("forward: %+v", forwarded)
	}
	var gotRoute route
	if err := json.Unmarshal(forwarded.Payload, &gotRoute); err != nil {
		t.Fatal(err)
	}
	if string(gotRoute.Message) != string(request) {
		t.Fatalf("MCP request changed: %s", gotRoute.Message)
	}
	result := json.RawMessage(`{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"image","data":"YWJj","mimeType":"image/png"}]}}`)
	if err := edge.WriteJSON(makeEnvelope("mcp.response", "m1", struct {
		Message json.RawMessage `json:"message"`
	}{result})); err != nil {
		t.Fatal(err)
	}
	response := receive(t, client)
	var body struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(response.Payload, &body); err != nil {
		t.Fatal(err)
	}
	if string(body.Message) != string(result) {
		t.Fatalf("MCP response changed: %s", body.Message)
	}
	_ = edge.Close()
	newEdge := dial(t, httpServer.URL)
	register(t, newEdge)
}

func TestValidationAndTimeout(t *testing.T) {
	s := New(nil)
	s.Timeout = 50 * time.Millisecond
	httpServer := httptest.NewServer(s)
	defer httpServer.Close()
	edge, client := dial(t, httpServer.URL), dial(t, httpServer.URL)
	register(t, edge)
	if err := client.WriteMessage(websocket.TextMessage, []byte("bad json")); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, client); got.Type != "edge.error" {
		t.Fatalf("malformed JSON: %+v", got)
	}
	m := makeEnvelope("mcp.request", "slow", route{MCPID: MCPID, Message: json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"ping"}`)})
	m.Email = "gui@example.com"
	if err := client.WriteJSON(m); err != nil {
		t.Fatal(err)
	}
	_ = receive(t, edge)
	if got := receive(t, client); got.Type != "edge.error" || got.RequestID != "slow" {
		t.Fatalf("timeout: %+v", got)
	}
}

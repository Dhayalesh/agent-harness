package websocketserver

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/edge-server/internal/protocol"
)

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func register(t *testing.T, c *websocket.Conn, email, device, request string) string {
	t.Helper()
	if err := c.WriteJSON(protocol.Message{Version: protocol.Version, Type: "edge.register", RequestID: request, Email: email, DeviceID: device}); err != nil {
		t.Fatal(err)
	}
	var reply protocol.Message
	if err := c.ReadJSON(&reply); err != nil {
		t.Fatal(err)
	}
	if reply.Type != "edge.registered" || reply.RequestID != request {
		t.Fatalf("unexpected registration: %+v", reply)
	}
	var payload struct {
		ConnectionID string `json:"connectionId"`
	}
	if json.Unmarshal(reply.Payload, &payload) != nil || !strings.HasPrefix(payload.ConnectionID, "conn-") {
		t.Fatalf("missing connection ID: %+v", reply)
	}
	return payload.ConnectionID
}

func TestEmailRegistrationReplacementHeartbeatAndRouting(t *testing.T) {
	s := New()
	h := httptest.NewServer(s)
	defer h.Close()
	base := "ws" + strings.TrimPrefix(h.URL, "http")
	email := "identifier-without-mailbox-verification"
	first := dial(t, base+"/ws")
	defer first.Close()
	_ = first.SetReadDeadline(time.Now().Add(3 * time.Second))
	firstID := register(t, first, email, "device-1", "r1")
	second := dial(t, base+"/ws")
	defer second.Close()
	_ = second.SetReadDeadline(time.Now().Add(3 * time.Second))
	secondID := register(t, second, email, "device-2", "r2")
	if firstID == secondID {
		t.Fatal("reconnection reused connection ID")
	}
	var closed protocol.Message
	if err := first.ReadJSON(&closed); err == nil {
		t.Fatal("previous connection remained open")
	}
	active, err := s.Devices.Get(email)
	if err != nil || active.ConnectionID != secondID {
		t.Fatalf("wrong active connection: %+v %v", active, err)
	}
	if err := second.WriteJSON(protocol.New("edge.heartbeat", "", map[string]string{"deviceId": "device-2"})); err != nil {
		t.Fatal(err)
	}
	var ack protocol.Message
	if err := second.ReadJSON(&ack); err != nil || ack.Type != "edge.heartbeat_ack" {
		t.Fatalf("heartbeat failed: %+v %v", ack, err)
	}

	harness := dial(t, base+"/harness/ws")
	defer harness.Close()
	_ = harness.SetReadDeadline(time.Now().Add(3 * time.Second))
	rpc := json.RawMessage(`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)
	if err := harness.WriteJSON(protocol.New("harness.mcp.request", "h1", protocol.Route{Email: email, MCPID: "sap-adt", Message: rpc})); err != nil {
		t.Fatal(err)
	}
	var routed protocol.Message
	if err := second.ReadJSON(&routed); err != nil {
		t.Fatal(err)
	}
	var route protocol.Route
	if routed.Type != "edge.mcp.request" || json.Unmarshal(routed.Payload, &route) != nil || route.MCPID != "sap-adt" || string(route.Message) != string(rpc) {
		t.Fatalf("bad route: %+v %+v", routed, route)
	}
	response := json.RawMessage(`{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}`)
	if err := second.WriteJSON(protocol.New("edge.mcp.response", routed.RequestID, protocol.Route{Message: response})); err != nil {
		t.Fatal(err)
	}
	var forwarded protocol.Message
	if err := harness.ReadJSON(&forwarded); err != nil {
		t.Fatal(err)
	}
	var result protocol.Route
	if forwarded.Type != "harness.mcp.response" || forwarded.RequestID != "h1" || json.Unmarshal(forwarded.Payload, &result) != nil || string(result.Message) != string(response) {
		t.Fatalf("bad response: %+v %+v", forwarded, result)
	}
}

func TestRegistrationRequiresNonemptyEmail(t *testing.T) {
	s := New()
	h := httptest.NewServer(s)
	defer h.Close()
	base := "ws" + strings.TrimPrefix(h.URL, "http") + "/ws"
	for _, email := range []string{"", "   "} {
		c := dial(t, base)
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if err := c.WriteJSON(protocol.Message{Version: protocol.Version, Type: "edge.register", RequestID: "r1", Email: email, DeviceID: "device-1"}); err != nil {
			t.Fatal(err)
		}
		var reply protocol.Message
		if err := c.ReadJSON(&reply); err == nil {
			t.Fatalf("empty email %q was accepted", email)
		}
		c.Close()
	}
}

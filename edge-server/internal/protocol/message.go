package protocol

import "encoding/json"

const Version = 1
const MaxControlBytes = 4096
const MaxRPCBytes = 8 << 20

// Message is the versioned transport envelope. MCP JSON-RPC remains opaque in Payload.Message.
type Message struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Email     string          `json:"email,omitempty"`
	DeviceID  string          `json:"deviceId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Route struct {
	Email   string          `json:"email,omitempty"`
	MCPID   string          `json:"mcpId"`
	Message json.RawMessage `json:"message"`
}

func New(typ, id string, payload any) Message {
	b, _ := json.Marshal(payload)
	return Message{Version: Version, Type: typ, RequestID: id, Payload: b}
}

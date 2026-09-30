package connection

import (
	"encoding/json"
	"fmt"
	"time"
)

const Version = 1
const MaxMessageBytes = 4096
const MaxRPCMessageBytes = 8 << 20

type Message struct {
	Version   int             `json:"version"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Email     string          `json:"email,omitempty"`
	DeviceID  string          `json:"deviceId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type MCPRoute struct {
	MCPID   string          `json:"mcpId"`
	Message json.RawMessage `json:"message"`
}

func newMessage(typ, id string, payload interface{}) Message {
	b, _ := json.Marshal(payload)
	return Message{Version: Version, Type: typ, RequestID: id, Payload: b}
}

func validateMessage(m Message) error {
	if m.Version != Version {
		return fmt.Errorf("unsupported protocol version")
	}
	switch m.Type {
	case "edge.registered":
		var p struct {
			ConnectionID string `json:"connectionId"`
		}
		if m.RequestID == "" || json.Unmarshal(m.Payload, &p) != nil || p.ConnectionID == "" {
			return fmt.Errorf("invalid registration response")
		}
	case "edge.heartbeat_ack":
		var p struct {
			ServerTime string `json:"serverTime"`
		}
		if json.Unmarshal(m.Payload, &p) != nil || p.ServerTime == "" {
			return fmt.Errorf("invalid heartbeat acknowledgement")
		}
		if _, err := time.Parse(time.RFC3339Nano, p.ServerTime); err != nil {
			return fmt.Errorf("invalid heartbeat server time")
		}
	default:
		return fmt.Errorf("unexpected server message type")
	}
	return nil
}

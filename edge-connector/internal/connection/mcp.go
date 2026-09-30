package connection

import (
	"context"
	"encoding/json"

	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/mcp/router"
)

// MCPHandler maps remote MCP requests into the already running local MCP router.
// It never accepts an executable, destination, or SAP credential from the wire.
func MCPHandler(reg *registry.Registry, local *router.Router) func(context.Context, string, json.RawMessage) json.RawMessage {
	return func(ctx context.Context, mcpID string, raw json.RawMessage) json.RawMessage {
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}
		if json.Unmarshal(raw, &req) != nil || req.JSONRPC != "2.0" || req.Method == "" {
			return rpcError(req.ID, protocol.CodeInvalidRequest, "invalid JSON-RPC request")
		}
		if req.Method == protocol.MethodInitialized {
			return json.RawMessage(`null`)
		}
		if len(req.ID) == 0 || string(req.ID) == "null" {
			return rpcError(json.RawMessage(`null`), protocol.CodeInvalidRequest, "request ID required")
		}
		if mcpID != "sap-adt" {
			return rpcError(req.ID, protocol.CodeInvalidParams, "MCP ID is not allowed")
		}
		inst, ok := reg.GetInstance(mcpID)
		if !ok {
			return rpcError(req.ID, protocol.CodeInternalError, "MCP unavailable")
		}
		if inst.Status().State != process.StateRunning {
			return rpcError(req.ID, protocol.CodeInternalError, "MCP unavailable")
		}
		var result any
		switch req.Method {
		case protocol.MethodInitialize:
			result = protocol.InitializeResult{ProtocolVersion: protocol.CurrentProtocolVersion, Capabilities: protocol.ServerCapabilities{Tools: &protocol.ToolsCapability{}}, ServerInfo: inst.ServerInfo()}
		case protocol.MethodToolsList:
			result = protocol.ToolsListResult{Tools: inst.Tools()}
		case protocol.MethodToolsCall:
			var p protocol.ToolsCallParams
			if json.Unmarshal(req.Params, &p) != nil || p.Name == "" {
				return rpcError(req.ID, protocol.CodeInvalidParams, "invalid tools/call parameters")
			}
			response, err := local.Route(ctx, router.CallRequest{RequestID: string(req.ID), MCPID: mcpID, Tool: p.Name, Arguments: p.Arguments})
			if err != nil {
				return rpcError(req.ID, protocol.CodeInternalError, "local MCP call failed")
			}
			result = response.Result
		case "ping":
			result = map[string]any{}
		default:
			return rpcError(req.ID, protocol.CodeMethodNotFound, "MCP method unsupported")
		}
		b, _ := json.Marshal(struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  any             `json:"result"`
		}{"2.0", req.ID, result})
		return b
	}
}

func rpcError(id json.RawMessage, code int, message string) json.RawMessage {
	if len(id) == 0 {
		id = json.RawMessage(`null`)
	}
	b, _ := json.Marshal(struct {
		JSONRPC string                `json:"jsonrpc"`
		ID      json.RawMessage       `json:"id"`
		Error   protocol.JSONRPCError `json:"error"`
	}{"2.0", id, protocol.JSONRPCError{Code: code, Message: message}})
	return b
}

package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Standard JSON-RPC 2.0 error codes
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternalError  = -32603
)

// MCP Protocol Constants
const (
	CurrentProtocolVersion = "2024-11-05"
	MethodInitialize       = "initialize"
	MethodInitialized      = "notifications/initialized"
	MethodToolsList        = "tools/list"
	MethodToolsCall        = "tools/call"
	MethodCancelRequest    = "$/cancelRequest"
)

// JSONRPCRequest represents a JSON-RPC 2.0 request or notification.
type JSONRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

// JSONRPCResponse represents a JSON-RPC 2.0 response.
type JSONRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *JSONRPCError   `json:"error,omitempty"`
}

// JSONRPCError represents a standard JSON-RPC 2.0 error object.
type JSONRPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *JSONRPCError) Error() string {
	return fmt.Sprintf("jsonrpc error (code %d): %s", e.Code, e.Message)
}

// ClientInfo describes the MCP client identity.
type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ClientCapabilities describes supported features by this Edge Connector client.
type ClientCapabilities struct {
	Roots    *RootsCapability    `json:"roots,omitempty"`
	Sampling *SamplingCapability `json:"sampling,omitempty"`
}

type RootsCapability struct {
	ListChanged bool `json:"listChanged,omitempty"`
}

type SamplingCapability struct{}

// InitializeParams is sent in the 'initialize' method.
type InitializeParams struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    ClientCapabilities `json:"capabilities"`
	ClientInfo      ClientInfo         `json:"clientInfo"`
}

// ServerInfo describes the MCP server identity.
type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ServerCapabilities lists features supported by the MCP server.
type ServerCapabilities struct {
	Tools     *ToolsCapability     `json:"tools,omitempty"`
	Resources *ResourcesCapability `json:"resources,omitempty"`
	Prompts   *PromptsCapability   `json:"prompts,omitempty"`
}

type ToolsCapability struct {
	ListChanged bool `json:"listChanged,omitempty"`
}

type ResourcesCapability struct {
	Subscribe   bool `json:"subscribe,omitempty"`
	ListChanged bool `json:"listChanged,omitempty"`
}

type PromptsCapability struct {
	ListChanged bool `json:"listChanged,omitempty"`
}

// InitializeResult is received from 'initialize'.
type InitializeResult struct {
	ProtocolVersion string             `json:"protocolVersion"`
	Capabilities    ServerCapabilities `json:"capabilities"`
	ServerInfo      ServerInfo         `json:"serverInfo"`
	Instructions    string             `json:"instructions,omitempty"`
}

// ToolDefinition describes an available MCP tool.
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// UnmarshalJSON unmarshals ToolDefinition, preserving inputSchema and supporting input_schema alias.
func (t *ToolDefinition) UnmarshalJSON(data []byte) error {
	type Alias ToolDefinition
	var aux struct {
		Alias
		AltSchema json.RawMessage `json:"input_schema,omitempty"`
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	*t = ToolDefinition(aux.Alias)
	if len(t.InputSchema) == 0 && len(aux.AltSchema) > 0 {
		t.InputSchema = aux.AltSchema
	}
	return nil
}

// FormatDescription returns a human-readable representation of the tool name, description, and input schema.
func (t ToolDefinition) FormatDescription() string {
	schemaStr := "{}"
	if len(t.InputSchema) > 0 {
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, t.InputSchema, "", "  "); err == nil {
			schemaStr = pretty.String()
		} else {
			schemaStr = string(t.InputSchema)
		}
	}
	desc := t.Description
	if desc == "" {
		desc = "(no description provided)"
	}
	return fmt.Sprintf("Name: %s\nDescription: %s\nInput Schema:\n%s", t.Name, desc, schemaStr)
}

// ToolsListResult is received from 'tools/list'.
type ToolsListResult struct {
	Tools      []ToolDefinition `json:"tools"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

// ToolsCallParams is sent in 'tools/call'.
type ToolsCallParams struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments,omitempty"`
}

// ToolContent represents an item in the tool call response content.
type ToolContent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

// ToolsCallResult is received from 'tools/call'.
type ToolsCallResult struct {
	Content []ToolContent `json:"content"`
	IsError bool          `json:"isError,omitempty"`
}

// CancelParams is sent in '$/cancelRequest'.
type CancelParams struct {
	RequestID interface{} `json:"requestId"`
	Reason    string      `json:"reason,omitempty"`
}


package protocol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

// mockServer simulates an MCP server over io.Reader and io.Writer
func runMockServer(t *testing.T, r io.Reader, w io.Writer) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Bytes()
		var req JSONRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		switch req.Method {
		case MethodInitialize:
			initResult := InitializeResult{
				ProtocolVersion: CurrentProtocolVersion,
				ServerInfo: ServerInfo{
					Name:    "mock-server",
					Version: "1.0.0",
				},
			}
			resBytes, _ := json.Marshal(initResult)
			resp := JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			respData, _ := json.Marshal(resp)
			w.Write(append(respData, '\n'))

		case MethodInitialized:
			// Notification, no reply

		case MethodToolsList:
			toolsResult := ToolsListResult{
				Tools: []ToolDefinition{
					{
						Name:        "read_abap_class",
						Description: "Reads ABAP class source code",
					},
					{
						Name:        "list_packages",
						Description: "Lists packages",
					},
				},
			}
			resBytes, _ := json.Marshal(toolsResult)
			resp := JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			respData, _ := json.Marshal(resp)
			w.Write(append(respData, '\n'))

		case MethodToolsCall:
			var params ToolsCallParams
			paramBytes, _ := json.Marshal(req.Params)
			json.Unmarshal(paramBytes, &params)

			if params.Name == "error_tool" {
				resp := JSONRPCResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error: &JSONRPCError{
						Code:    CodeInternalError,
						Message: "tool failed execution",
					},
				}
				respData, _ := json.Marshal(resp)
				w.Write(append(respData, '\n'))
				continue
			}

			callResult := ToolsCallResult{
				Content: []ToolContent{
					{
						Type: "text",
						Text: "CLASS zcl_test DEFINITION. ENDCLASS.",
					},
				},
			}
			resBytes, _ := json.Marshal(callResult)
			resp := JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			respData, _ := json.Marshal(resp)
			w.Write(append(respData, '\n'))

		case MethodCancelRequest:
			// Acknowledged notification
		}
	}
}

func TestProtocolClientSuccess(t *testing.T) {
	clientReader, serverWriter := io.Pipe()
	serverReader, clientWriter := io.Pipe()

	go runMockServer(t, serverReader, serverWriter)

	client := NewClient(clientReader, clientWriter, nil)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// 1. Initialize
	initRes, err := client.Initialize(ctx, "TrueAI-Edge", "1.0.0")
	if err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}
	if initRes.ServerInfo.Name != "mock-server" {
		t.Errorf("Expected server name 'mock-server', got %s", initRes.ServerInfo.Name)
	}

	// 2. Tools List
	toolsRes, err := client.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	if len(toolsRes.Tools) != 2 {
		t.Fatalf("Expected 2 tools, got %d", len(toolsRes.Tools))
	}
	if toolsRes.Tools[0].Name != "read_abap_class" {
		t.Errorf("Expected tool name 'read_abap_class', got %s", toolsRes.Tools[0].Name)
	}

	// 3. Tools Call
	callRes, err := client.CallTool(ctx, "read_abap_class", map[string]interface{}{"class_name": "ZCL_TEST"})
	if err != nil {
		t.Fatalf("CallTool failed: %v", err)
	}
	if len(callRes.Content) != 1 || !bytes.Contains([]byte(callRes.Content[0].Text), []byte("CLASS zcl_test")) {
		t.Errorf("Unexpected tool result content: %v", callRes.Content)
	}

	// 4. Tools Call Error
	_, err = client.CallTool(ctx, "error_tool", nil)
	if err == nil {
		t.Fatalf("Expected error calling error_tool, got nil")
	}
}

func TestProtocolClientCancellation(t *testing.T) {
	clientReader, _ := io.Pipe()
	buf := &bytes.Buffer{}

	client := NewClient(clientReader, buf, nil)
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := client.CallTool(ctx, "slow_tool", nil)
	if err == nil {
		t.Fatal("Expected context cancellation error, got nil")
	}
}

func TestToolDefinition_FormatDescription(t *testing.T) {
	tool := ToolDefinition{
		Name:        "GetObjectsList",
		Description: "Retrieve list of ABAP objects",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"filter":{"type":"string"}},"required":["filter"]}`),
	}

	formatted := tool.FormatDescription()

	if !strings.Contains(formatted, "Name: GetObjectsList") {
		t.Errorf("Expected Name: GetObjectsList, got:\n%s", formatted)
	}
	if !strings.Contains(formatted, "Description: Retrieve list of ABAP objects") {
		t.Errorf("Expected Description in output, got:\n%s", formatted)
	}
	if !strings.Contains(formatted, `"filter"`) || !strings.Contains(formatted, `"required"`) {
		t.Errorf("Expected pretty-printed inputSchema in output, got:\n%s", formatted)
	}
}

func TestToolDefinition_UnmarshalAliasesAndPreserveSchema(t *testing.T) {
	// Standard inputSchema
	rawJSON1 := `{"name":"tool1","description":"desc1","inputSchema":{"type":"object","properties":{"p1":{"type":"string"}}}}`
	var t1 ToolDefinition
	if err := json.Unmarshal([]byte(rawJSON1), &t1); err != nil {
		t.Fatalf("Failed to unmarshal t1: %v", err)
	}
	if t1.Name != "tool1" || len(t1.InputSchema) == 0 {
		t.Errorf("Expected tool1 with inputSchema, got: %+v", t1)
	}

	// input_schema alias
	rawJSON2 := `{"name":"tool2","description":"desc2","input_schema":{"type":"object","properties":{"p2":{"type":"number"}}}}`
	var t2 ToolDefinition
	if err := json.Unmarshal([]byte(rawJSON2), &t2); err != nil {
		t.Fatalf("Failed to unmarshal t2: %v", err)
	}
	if t2.Name != "tool2" || len(t2.InputSchema) == 0 {
		t.Errorf("Expected tool2 with input_schema unmarshaled, got: %+v", t2)
	}

	// Empty schema
	var t3 ToolDefinition
	t3.Name = "tool3"
	formatted3 := t3.FormatDescription()
	if !strings.Contains(formatted3, "Name: tool3") || !strings.Contains(formatted3, "Input Schema:\n{}") {
		t.Errorf("Expected empty schema formatted as {}, got:\n%s", formatted3)
	}
}


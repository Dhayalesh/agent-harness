package router

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/policy"
)

func TestRouterHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_ROUTER_HELPER") != "1" {
		return
	}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Bytes()
		var req protocol.JSONRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		switch req.Method {
		case protocol.MethodInitialize:
			initResult := protocol.InitializeResult{
				ProtocolVersion: protocol.CurrentProtocolVersion,
				ServerInfo: protocol.ServerInfo{
					Name:    "router-helper-mcp",
					Version: "1.0.0",
				},
			}
			resBytes, _ := json.Marshal(initResult)
			resp := protocol.JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			data, _ := json.Marshal(resp)
			fmt.Println(string(data))

		case protocol.MethodInitialized:
			// No response needed

		case protocol.MethodToolsList:
			listResult := protocol.ToolsListResult{
				Tools: []protocol.ToolDefinition{
					{Name: "read_abap_class", Description: "ABAP Class Reader"},
				},
			}
			resBytes, _ := json.Marshal(listResult)
			resp := protocol.JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			data, _ := json.Marshal(resp)
			fmt.Println(string(data))

		case protocol.MethodToolsCall:
			callResult := protocol.ToolsCallResult{
				Content: []protocol.ToolContent{
					{Type: "text", Text: "CLASS zcl_demo DEFINITION. ENDCLASS."},
				},
			}
			resBytes, _ := json.Marshal(callResult)
			resp := protocol.JSONRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  resBytes,
			}
			data, _ := json.Marshal(resp)
			fmt.Println(string(data))
		}
	}
	os.Exit(0)
}

func TestRouterExecution(t *testing.T) {
	pm := process.NewProcessManager(nil)
	reg := registry.NewRegistry(pm, nil)

	pol := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
		AllowedTools: map[string][]string{
			"sap-adt": {"read_abap_class"},
		},
	}, nil)

	r := NewRouter(reg, pol, nil)

	m := &manifest.Manifest{
		ID:         "sap-adt",
		Name:       "SAP ADT MCP",
		Version:    "1.0.0",
		Transport:  "stdio",
		Executable: os.Args[0],
		Arguments:  []string{"-test.run=TestRouterHelperProcess"},
		Env: map[string]string{
			"GO_WANT_ROUTER_HELPER": "1",
		},
		StartupTimeout: 5 * time.Second,
		RequestTimeout: 5 * time.Second,
		RestartPolicy:  manifest.DefaultRestartPolicy(),
	}

	_, err := reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register manifest: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Successful route & tool execution
	resp, err := r.Route(ctx, CallRequest{
		RequestID: "req-1",
		MCPID:     "sap-adt",
		Tool:      "read_abap_class",
		Arguments: map[string]interface{}{"class_name": "ZCL_DEMO"},
	})
	if err != nil {
		t.Fatalf("Route failed: %v", err)
	}
	if resp.IsError {
		t.Errorf("Expected success, got isError=true")
	}

	// 2. Reject unknown MCP
	_, err = r.Route(ctx, CallRequest{
		RequestID: "req-2",
		MCPID:     "unregistered-mcp",
		Tool:      "read_abap_class",
	})
	if err == nil {
		t.Fatal("Expected error for unknown MCP, got nil")
	}

	// 3. Reject unknown / unwhitelisted tool
	_, err = r.Route(ctx, CallRequest{
		RequestID: "req-3",
		MCPID:     "sap-adt",
		Tool:      "delete_database",
	})
	if err == nil {
		t.Fatal("Expected error for disallowed tool, got nil")
	}

	// 4. Reject forbidden execution parameters
	_, err = r.Route(ctx, CallRequest{
		RequestID: "req-4",
		MCPID:     "sap-adt",
		Tool:      "read_abap_class",
		Arguments: map[string]interface{}{"cmd": "calc.exe"},
	})
	if err == nil || !errors.Is(err, policy.ErrDisallowedParameter) {
		t.Fatalf("Expected ErrDisallowedParameter, got: %v", err)
	}

	// 5. Test shutdown rejection
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelShutdown()
	_ = r.Close(shutdownCtx)

	_, err = r.Route(ctx, CallRequest{
		RequestID: "req-5",
		MCPID:     "sap-adt",
		Tool:      "read_abap_class",
	})
	if err == nil || !errors.Is(err, ErrRouterShuttingDown) {
		t.Fatalf("Expected ErrRouterShuttingDown, got: %v", err)
	}

	pm.StopAll(ctx)
}


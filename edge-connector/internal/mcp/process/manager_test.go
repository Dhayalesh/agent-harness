package process

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
)

// TestHelperProcess serves as the mock child process when invoked with -test.run=TestHelperProcess
func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}

	mode := os.Getenv("MOCK_MODE")
	if mode == "crash_immediately" {
		os.Exit(42)
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
					Name:    "test-helper-mcp",
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
			if mode == "crash_on_call" {
				os.Exit(99)
			}
			callResult := protocol.ToolsCallResult{
				Content: []protocol.ToolContent{
					{Type: "text", Text: "success"},
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

func makeTestManifest(id string, mode string, restartPolicy manifest.RestartPolicy) *manifest.Manifest {
	return &manifest.Manifest{
		ID:         id,
		Name:       "Test MCP",
		Version:    "1.0.0",
		Transport:  "stdio",
		Executable: os.Args[0],
		Arguments:  []string{"-test.run=TestHelperProcess"},
		Env: map[string]string{
			"GO_WANT_HELPER_PROCESS": "1",
			"MOCK_MODE":              mode,
		},
		StartupTimeout: 5 * time.Second,
		RequestTimeout: 5 * time.Second,
		RestartPolicy:  restartPolicy,
	}
}

func TestProcessLifecycle(t *testing.T) {
	m := makeTestManifest("test-lifecycle", "normal", manifest.RestartPolicy{
		MaxRestarts:    2,
		CrashWindow:    10 * time.Second,
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     1 * time.Second,
	})

	inst := NewInstance(m, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Start
	if err := inst.Start(ctx); err != nil {
		t.Fatalf("Failed to start instance: %v", err)
	}

	// Verify running status
	status := inst.Status()
	if status.State != StateRunning {
		t.Fatalf("Expected StateRunning, got %v", status.State)
	}
	if status.PID <= 0 {
		t.Fatalf("Expected valid PID, got %d", status.PID)
	}
	if len(inst.Tools()) != 1 || inst.Tools()[0].Name != "read_abap_class" {
		t.Fatalf("Discovered tools mismatch: %v", inst.Tools())
	}

	// 2. Stop
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelStop()
	if err := inst.Stop(stopCtx); err != nil {
		t.Fatalf("Failed to stop instance: %v", err)
	}

	statusAfter := inst.Status()
	if statusAfter.State != StateStopped {
		t.Fatalf("Expected StateStopped, got %v", statusAfter.State)
	}
	if statusAfter.PID != 0 {
		t.Fatalf("Expected PID 0 after stop, got %d", statusAfter.PID)
	}
}

func TestRestartLoopProtection(t *testing.T) {
	// Manifest configured with mock mode crash_immediately and MaxRestarts: 2
	m := makeTestManifest("test-crash", "crash_immediately", manifest.RestartPolicy{
		MaxRestarts:    2,
		CrashWindow:    5 * time.Second,
		InitialBackoff: 20 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
	})

	inst := NewInstance(m, nil)

	// Direct Start will fail initialize because process crashes immediately
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := inst.Start(ctx)
	if err == nil {
		t.Fatalf("Expected Start to fail for immediate crash, got nil")
	}

	status := inst.Status()
	if status.State != StateCrashed {
		t.Errorf("Expected StateCrashed, got %v", status.State)
	}
}

func TestProcessManager(t *testing.T) {
	pm := NewProcessManager(nil)
	m := makeTestManifest("mcp-pm", "normal", manifest.DefaultRestartPolicy())

	inst, err := pm.Register(m)
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	got, found := pm.Get("mcp-pm")
	if !found || got != inst {
		t.Fatalf("Get failed to retrieve registered instance")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := inst.Start(ctx); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	all := pm.All()
	if len(all) != 1 {
		t.Fatalf("Expected 1 instance in All(), got %d", len(all))
	}

	pm.StopAll(ctx)

	if inst.Status().State != StateStopped {
		t.Errorf("Expected StateStopped after StopAll, got %v", inst.Status().State)
	}
}

func TestInstance_GetToolAndDescribeTool(t *testing.T) {
	m := &manifest.Manifest{
		ID:        "test-mcp",
		Name:      "Test MCP",
		Transport: "stdio",
	}
	inst := NewInstance(m, nil)

	// Manually populate discovered tools
	inst.mu.Lock()
	inst.tools = []protocol.ToolDefinition{
		{
			Name:        "GetObjectsList",
			Description: "Retrieve list of ABAP objects",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"filter":{"type":"string"}},"required":["filter"]}`),
		},
		{
			Name:        "ReadSourceCode",
			Description: "Read source code of an ABAP object",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"uri":{"type":"string"}}}`),
		},
	}
	inst.mu.Unlock()

	// 1. GetTool exact match
	tool, found := inst.GetTool("GetObjectsList")
	if !found {
		t.Fatalf("Expected GetObjectsList to be found")
	}
	if tool.Name != "GetObjectsList" || len(tool.InputSchema) == 0 {
		t.Errorf("Unexpected tool retrieved: %+v", tool)
	}

	// 2. GetTool case-insensitive match
	toolLower, foundLower := inst.GetTool("getobjectslist")
	if !foundLower || toolLower.Name != "GetObjectsList" {
		t.Errorf("Expected case-insensitive match for getobjectslist, got: found=%v, tool=%+v", foundLower, toolLower)
	}

	// 3. DescribeTool success
	desc, err := inst.DescribeTool("GetObjectsList")
	if err != nil {
		t.Fatalf("DescribeTool failed: %v", err)
	}
	if !strings.Contains(desc, "Name: GetObjectsList") || !strings.Contains(desc, `"filter"`) {
		t.Errorf("Unexpected description output:\n%s", desc)
	}

	// 4. DescribeTool not found
	_, errNotFound := inst.DescribeTool("NonExistentTool")
	if errNotFound == nil {
		t.Fatalf("Expected error for non-existent tool, got nil")
	}
	if !strings.Contains(errNotFound.Error(), "NonExistentTool") || !strings.Contains(errNotFound.Error(), "2 discovered tools") {
		t.Errorf("Expected helpful error message with tool count, got: %v", errNotFound)
	}
}


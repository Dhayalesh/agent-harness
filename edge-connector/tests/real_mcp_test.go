package tests

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/mcp/router"
	"github.com/trueai/edge-connector/internal/policy"
)

// TestRealSAPADTMCPIntegration verifies integration with the real SAP ABAP ADT MCP server.
// This test is decoupled from normal offline unit tests and requires explicit activation:
//
//	$env:TRUEAI_TEST_REAL_SAP="1"
//	$env:TRUEAI_SAP_DESTINATION="DEV" (optional, defaults to DEV)
//	$env:TRUEAI_SAP_EXECUTABLE="C:\path\to\mcp-abap-adt" (optional, path or name of externally supplied executable)
//	go test -v -run TestRealSAPADTMCPIntegration ./tests
func TestRealSAPADTMCPIntegration(t *testing.T) {
	if os.Getenv("TRUEAI_TEST_REAL_SAP") != "1" {
		t.Skip("Skipping Real SAP ADT MCP integration test: set TRUEAI_TEST_REAL_SAP=1 to execute")
	}

	destination := os.Getenv("TRUEAI_SAP_DESTINATION")
	if destination == "" {
		destination = "DEV"
	}

	// 1. Locate trusted real MCP executable (externally supplied artifact)
	executable := os.Getenv("TRUEAI_SAP_EXECUTABLE")
	if executable == "" {
		executable = "mcp-abap-adt"
	}

	// Check if executable exists in PATH or local non-admin directories
	resolvedExec, err := exec.LookPath(executable)
	if err != nil {
		// Check %LOCALAPPDATA%\TrueAI\Edge\bin
		localApp := os.Getenv("LOCALAPPDATA")
		if localApp != "" {
			candidate := filepath.Join(localApp, "TrueAI", "Edge", "bin", executable)
			if _, statErr := os.Stat(candidate); statErr == nil {
				resolvedExec = candidate
			} else if _, statErr := os.Stat(candidate + ".exe"); statErr == nil {
				resolvedExec = candidate + ".exe"
			}
		}
	}

	if resolvedExec == "" {
		t.Skipf("Skipping: externally supplied real SAP ADT MCP executable '%s' not found on system PATH or %%LOCALAPPDATA%%\\TrueAI\\Edge\\bin", executable)
	}

	t.Logf("Found real SAP ADT MCP executable: %s", resolvedExec)
	t.Logf("Targeting SAP Destination: %s", destination)

	// 2. Build manifest for Real MCP
	m := &manifest.Manifest{
		ID:             "sap-adt",
		Name:           "Real SAP ABAP ADT MCP",
		Version:        "1.0.0",
		Transport:      "stdio",
		Executable:     resolvedExec,
		Destination:    destination,
		Arguments:      []string{"--transport=stdio"},
		StartupTimeout: 30 * time.Second,
		RequestTimeout: 60 * time.Second,
		RestartPolicy: manifest.RestartPolicy{
			MaxRestarts:    3,
			CrashWindow:    60 * time.Second,
			InitialBackoff: 1 * time.Second,
			MaxBackoff:     10 * time.Second,
		},
		AllowedTools: []string{"*"}, // Allow all dynamically discovered tools
	}

	envPath := os.Getenv("TRUEAI_SAP_ENV_PATH")
	if envPath != "" {
		m.EnvPath = envPath
	}
	sysType := os.Getenv("TRUEAI_SAP_SYSTEM_TYPE")
	if sysType != "" {
		m.SystemType = sysType
	}

	// Verify invocation contract
	effArgs := m.EffectiveArguments()
	t.Logf("Verified effective MCP process arguments: %v", effArgs)
	hasTransport := false
	hasDestination := false
	hasEnvPath := false
	hasSystemType := false
	for _, arg := range effArgs {
		if arg == "--transport=stdio" {
			hasTransport = true
		}
		if destination != "" && arg == "--mcp="+destination {
			hasDestination = true
		}
		if envPath != "" && strings.HasPrefix(arg, "--env-path=") {
			hasEnvPath = true
		}
		if sysType != "" && arg == "--system-type="+sysType {
			hasSystemType = true
		}
	}
	if !hasTransport {
		t.Errorf("Expected --transport=stdio in EffectiveArguments, got %v", effArgs)
	}
	if destination != "" && !hasDestination {
		t.Errorf("Expected --mcp=%s in EffectiveArguments, got %v", destination, effArgs)
	}
	if envPath != "" && !hasEnvPath {
		t.Errorf("Expected --env-path in EffectiveArguments, got %v", effArgs)
	}
	if sysType != "" && !hasSystemType {
		t.Errorf("Expected --system-type=%s in EffectiveArguments, got %v", sysType, effArgs)
	}

	// Verify absence of unverified SAP_DESTINATION in environment
	effEnv := m.EffectiveEnv()
	if _, exists := effEnv["SAP_DESTINATION"]; exists {
		t.Errorf("EffectiveEnv should NOT contain unverified SAP_DESTINATION environment variable")
	}

	// 3. Initialize Process Manager & Registry
	pm := process.NewProcessManager(nil)
	reg := registry.NewRegistry(pm, nil)

	inst, err := reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register real MCP manifest: %v", err)
	}

	pol := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
	}, nil)

	r := router.NewRouter(reg, pol, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// 4. Launch child process and perform handshake + dynamic tool discovery
	t.Log("Starting Real SAP ADT MCP process...")
	if err := inst.Start(ctx); err != nil {
		t.Fatalf("Failed to start Real SAP ADT MCP process: %v", err)
	}

	status := inst.Status()
	t.Logf("Process running with PID: %d, state: %s", status.PID, status.State)

	// 5. Inspect dynamically discovered tools from real MCP
	discoveredTools := inst.Tools()
	if len(discoveredTools) == 0 {
		t.Errorf("Expected dynamically discovered tools from real SAP ADT MCP, got 0")
	} else {
		t.Logf("Successfully discovered %d tools from real SAP ADT MCP:", len(discoveredTools))
		for _, tool := range discoveredTools {
			t.Logf(" - %s: %s", tool.Name, tool.Description)
		}
	}

	// 6. Optional tool execution if live SAP query is requested
	if os.Getenv("TRUEAI_TEST_REAL_TOOL_CALL") == "1" {
		t.Log("Executing real tool call against SAP...")
		callResp, err := r.Route(ctx, router.CallRequest{
			RequestID: "real-test-call-1",
			MCPID:     "sap-adt",
			Tool:      "read_abap_class",
			Arguments: map[string]interface{}{
				"class_name": "CL_ABAP_CHAR_UTILITIES",
			},
		})
		if err != nil {
			t.Logf("Tool call returned error: %v", err)
		} else {
			t.Logf("Tool call returned %d content blocks (isError=%v)", len(callResp.Result.Content), callResp.IsError)
		}
	}

	// 7. Clean shutdown
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelStop()

	_ = r.Close(stopCtx)
	pm.StopAll(stopCtx)

	if inst.Status().State != process.StateStopped {
		t.Errorf("Expected process state to be Stopped, got: %s", inst.Status().State)
	}
	t.Log("Real SAP ADT MCP integration test completed successfully.")
}

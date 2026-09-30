package tests

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/mcp/router"
	"github.com/trueai/edge-connector/internal/policy"
)

// Security Test A: Remote request cannot override executable
func TestSecurity_RemoteCannotOverrideExecutable(t *testing.T) {
	engine := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
	}, nil)

	maliciousKeys := []string{"executable", "exec"}
	for _, key := range maliciousKeys {
		args := map[string]interface{}{
			key: "cmd.exe",
		}
		err := engine.ValidateArguments(args)
		if err == nil {
			t.Errorf("Expected policy rejection for argument key '%s', got nil", key)
		} else if !errors.Is(err, policy.ErrDisallowedParameter) {
			t.Errorf("Expected ErrDisallowedParameter for '%s', got: %v", key, err)
		}
	}
}

// Security Test B: Remote request cannot override destination
func TestSecurity_RemoteCannotOverrideDestination(t *testing.T) {
	engine := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
	}, nil)

	destKeys := []string{"destination", "mcp_destination", "sap_destination"}
	for _, key := range destKeys {
		args := map[string]interface{}{
			key: "PRODUCTION",
		}
		err := engine.ValidateArguments(args)
		if err == nil {
			t.Errorf("Expected policy rejection for argument key '%s', got nil", key)
		} else if !errors.Is(err, policy.ErrDisallowedParameter) {
			t.Errorf("Expected ErrDisallowedParameter for '%s', got: %v", key, err)
		}
	}
}

// Security Test C: Remote request cannot inject arbitrary process arguments
func TestSecurity_RemoteCannotInjectProcessArguments(t *testing.T) {
	engine := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
	}, nil)

	forbiddenProcessKeys := []string{
		"cmd", "command", "shell", "powershell", "bash", "python", "script",
	}
	for _, key := range forbiddenProcessKeys {
		args := map[string]interface{}{
			key: "malicious_payload",
		}
		err := engine.ValidateArguments(args)
		if err == nil {
			t.Errorf("Expected policy rejection for argument key '%s', got nil", key)
		} else if !errors.Is(err, policy.ErrDisallowedParameter) {
			t.Errorf("Expected ErrDisallowedParameter for '%s', got: %v", key, err)
		}
	}
}

// Security Test D: Remote request cannot inject environment variables or working dir
func TestSecurity_RemoteCannotInjectEnvironmentOrCwd(t *testing.T) {
	engine := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
	}, nil)

	forbiddenEnvKeys := []string{
		"env", "environment", "env_path", "envpath", "env_file", "envfile",
		"system_type", "systemtype",
		"cwd", "working_dir", "working_directory",
		"service_key", "servicekey", "credentials", "auth",
	}
	for _, key := range forbiddenEnvKeys {
		args := map[string]interface{}{
			key: "secret_value",
		}
		err := engine.ValidateArguments(args)
		if err == nil {
			t.Errorf("Expected policy rejection for argument key '%s', got nil", key)
		} else if !errors.Is(err, policy.ErrDisallowedParameter) {
			t.Errorf("Expected ErrDisallowedParameter for '%s', got: %v", key, err)
		}
	}
}

// Security Test E: Destination cannot inject additional command-line arguments or shell metacharacters
func TestSecurity_DestinationCannotInjectArguments(t *testing.T) {
	invalidDestinations := []string{
		"-f",
		"--all",
		"--transport=http",
		"DEV; rm -rf /",
		"DEV && calc",
		"DEV | netstat",
		"DEV foo",
		"DEV\n",
		"DEV\r",
		"DEV`id`",
		"DEV$HOME",
	}

	for _, dest := range invalidDestinations {
		m := &manifest.Manifest{
			ID:          "sap-adt",
			Transport:   "stdio",
			Executable:  "mcp-abap-adt",
			Destination: dest,
		}
		err := m.Validate()
		if err == nil {
			t.Errorf("Expected validation failure for dangerous destination '%s', got nil", dest)
		}
	}

	validDestinations := []string{
		"DEV",
		"dev100",
		"PRD-01",
		"S4HANA_DEV.SYSTEM",
	}
	for _, dest := range validDestinations {
		m := &manifest.Manifest{
			ID:          "sap-adt",
			Transport:   "stdio",
			Executable:  "mcp-abap-adt",
			Destination: dest,
		}
		if err := m.Validate(); err != nil {
			t.Errorf("Expected valid destination '%s' to pass validation, got: %v", dest, err)
		}
	}
}

// Security Test F: Edge does not generate SAP_DESTINATION
func TestSecurity_EdgeDoesNotGenerateSAPDestination(t *testing.T) {
	// 1. Check in-memory manifest
	m := &manifest.Manifest{
		ID:          "sap-adt",
		Transport:   "stdio",
		Executable:  "mcp-abap-adt",
		Destination: "DEV",
		Env: map[string]string{
			"CUSTOM_VAR": "value",
		},
	}

	effEnv := m.EffectiveEnv()
	if val, exists := effEnv["SAP_DESTINATION"]; exists {
		t.Errorf("EffectiveEnv must NOT contain SAP_DESTINATION, found: %s", val)
	}

	// 2. Check production manifest file
	manifestPath := filepath.Join("..", "mcp", "manifests", "sap-adt.yaml")
	loadedManifest, err := manifest.LoadFromFile(manifestPath)
	if err != nil {
		t.Fatalf("Failed to load production manifest: %v", err)
	}

	loadedEnv := loadedManifest.EffectiveEnv()
	if val, exists := loadedEnv["SAP_DESTINATION"]; exists {
		t.Errorf("Production manifest EffectiveEnv must NOT contain SAP_DESTINATION, found: %s", val)
	}
}

// Security Test G: Service-key contents are never handled by Edge
// Performs a static source audit of internal/ to assert that Edge never accesses service-key files or contents.
func TestSecurity_ServiceKeyNeverHandledByEdge(t *testing.T) {
	internalDir := filepath.Join("..", "internal")
	err := filepath.Walk(internalDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}

		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}

		contentStr := string(content)
		// Edge code must never target service-keys directory or attempt to open service keys
		if strings.Contains(contentStr, "service-keys") {
			t.Errorf("Security boundary violation: %s references 'service-keys'", path)
		}
		if strings.Contains(contentStr, "service_key.json") || strings.Contains(contentStr, "service-key.json") {
			t.Errorf("Security boundary violation: %s references service key file pattern", path)
		}
		return nil
	})

	if err != nil {
		t.Fatalf("Failed to walk internal directory: %v", err)
	}
}

// Security Test H: MCP stdout/stderr remain separated
// Verifies that noisy stderr output never corrupts JSON-RPC 2.0 communication on stdout.
func TestSecurity_StdoutStderrSeparated(t *testing.T) {
	// Simulate stdout with valid JSON-RPC 2.0 protocol traffic
	stdoutReader, stdoutWriter := io.Pipe()

	// Simulate stderr with noisy diagnostic output
	stderrReader, stderrWriter := io.Pipe()

	// Simulate stdin with client requests
	stdinReader, stdinWriter := io.Pipe()

	client := protocol.NewClient(stdoutReader, stdinWriter, nil)

	// Collect stderr concurrently (mimicking process supervisor's drainStderr)
	var stderrBuf bytes.Buffer
	var stderrMu sync.Mutex
	stderrDrained := make(chan struct{})
	go func() {
		defer close(stderrDrained)
		scanner := bufio.NewScanner(stderrReader)
		for scanner.Scan() {
			stderrMu.Lock()
			stderrBuf.WriteString(scanner.Text() + "\n")
			stderrMu.Unlock()
		}
	}()

	// Diagnostic lines emitted by MCP process over stderr
	diagnosticLines := []string{
		"WARNING: SAP connection latency high",
		"ERROR: RFC trace buffer flushed",
		"DEBUG: auth handshake ok",
		"INFO: RFC destination DEV connected",
	}

	// Simulated MCP process emitting stderr diagnostics independently
	go func() {
		for _, line := range diagnosticLines {
			_, _ = fmt.Fprintln(stderrWriter, line)
		}
		_ = stderrWriter.Close()
	}()

	// Simulated MCP server loop: continuously consumes stdin and dispatches responses to stdout
	fixtureDone := make(chan struct{})
	go func() {
		defer close(fixtureDone)
		defer stdoutWriter.Close()

		scanner := bufio.NewScanner(stdinReader)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}

			var req protocol.JSONRPCRequest
			if err := json.Unmarshal(line, &req); err != nil {
				continue
			}

			switch req.Method {
			case protocol.MethodInitialize:
				resp := protocol.JSONRPCResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result: json.RawMessage(`{
						"protocolVersion": "2024-11-05",
						"capabilities": { "tools": {} },
						"serverInfo": { "name": "test-server", "version": "1.0.0" }
					}`),
				}
				data, _ := json.Marshal(resp)
				data = append(data, '\n')
				_, _ = stdoutWriter.Write(data)

			case protocol.MethodInitialized:
				// Initialized notification received; no response required

			case protocol.MethodToolsList:
				resp := protocol.JSONRPCResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result: json.RawMessage(`{
						"tools": [
							{"name": "read_abap_class", "description": "Read ABAP class"}
						]
					}`),
				}
				data, _ := json.Marshal(resp)
				data = append(data, '\n')
				_, _ = stdoutWriter.Write(data)
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Perform Initialize handshake
	initResult, err := client.Initialize(ctx, "TrueAI-Edge", "1.0.0")
	if err != nil {
		t.Fatalf("Client handshake failed due to stream corruption or deadlock: %v", err)
	}

	if initResult.ServerInfo.Name != "test-server" {
		t.Errorf("Expected serverInfo.name 'test-server', got '%s'", initResult.ServerInfo.Name)
	}

	// 2. Perform a tool list call to verify continued uncorrupted bidirectional communication
	toolsList, err := client.ListTools(ctx)
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	if len(toolsList.Tools) != 1 || toolsList.Tools[0].Name != "read_abap_class" {
		t.Errorf("Unexpected tools list: %v", toolsList)
	}

	// 3. Clean teardown: close stdinWriter to terminate fixture's scanner loop
	_ = stdinWriter.Close()

	// Wait for fixture to exit cleanly
	select {
	case <-fixtureDone:
	case <-time.After(3 * time.Second):
		t.Fatal("Timeout waiting for fixture to exit cleanly")
	}

	_ = client.Close()
	_ = stdoutReader.Close()
	_ = stdinReader.Close()
	_ = stderrReader.Close()

	// Wait for stderr draining to complete
	select {
	case <-stderrDrained:
	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for stderr draining to complete")
	}

	// 4. Verify stderr was captured and remained separate
	stderrMu.Lock()
	capturedStderr := stderrBuf.String()
	stderrMu.Unlock()

	for _, expectedLine := range diagnosticLines {
		if !strings.Contains(capturedStderr, expectedLine) {
			t.Errorf("Expected stderr to contain '%s', but got:\n%s", expectedLine, capturedStderr)
		}
	}
}

// Security Regression Test: Process-level stdout and stderr separation with noisy child process
func TestSecurity_ProcessLevelStdoutStderrSeparated(t *testing.T) {
	tempDir := t.TempDir()
	fakeMCPBinary := filepath.Join(tempDir, "fake-noisy-mcp.exe")

	buildCmd := exec.Command("go", "build", "-o", fakeMCPBinary, "./fixtures/fake-mcp/main.go")
	buildCmd.Env = os.Environ()
	buildOut, err := buildCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Failed to build fake-mcp fixture: %v, output: %s", err, string(buildOut))
	}

	m := &manifest.Manifest{
		ID:             "sap-noisy-test",
		Name:           "Noisy SAP ADT MCP",
		Version:        "1.0.0",
		Transport:      "stdio",
		Executable:     fakeMCPBinary,
		Arguments:      []string{"-noisy-stderr"},
		StartupTimeout: 5 * time.Second,
		RequestTimeout: 5 * time.Second,
		RestartPolicy: manifest.RestartPolicy{
			MaxRestarts:    1,
			CrashWindow:    10 * time.Second,
			InitialBackoff: 50 * time.Millisecond,
			MaxBackoff:     100 * time.Millisecond,
		},
		AllowedTools: []string{"read_abap_class"},
	}

	pm := process.NewProcessManager(nil)
	reg := registry.NewRegistry(pm, nil)
	inst, err := reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register manifest: %v", err)
	}

	pol := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-noisy-test"},
		AllowedTools: map[string][]string{
			"sap-noisy-test": {"read_abap_class"},
		},
	}, nil)

	r := router.NewRouter(reg, pol, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// 1. Process startup, initialize handshake, and dynamic tool discovery
	if err := inst.Start(ctx); err != nil {
		t.Fatalf("Failed to start noisy MCP process: %v", err)
	}

	if inst.Status().State != process.StateRunning {
		t.Fatalf("Expected process to be in StateRunning, got: %s", inst.Status().State)
	}

	// 2. Route tool call while child process writes diagnostics to stderr
	callResp, err := r.Route(ctx, router.CallRequest{
		RequestID: "noisy-req-1",
		MCPID:     "sap-noisy-test",
		Tool:      "read_abap_class",
		Arguments: map[string]interface{}{
			"class_name": "ZCL_TEST_NOISY",
		},
	})
	if err != nil {
		t.Fatalf("Failed to route tool call to noisy MCP: %v", err)
	}
	if callResp.IsError {
		t.Errorf("Expected callResp.IsError=false, got true")
	}
	if len(callResp.Result.Content) == 0 {
		t.Fatalf("Expected content in tool response")
	}
	if !strings.Contains(callResp.Result.Content[0].Text, "ZCL_TEST_NOISY") {
		t.Errorf("Unexpected tool output: %s", callResp.Result.Content[0].Text)
	}

	// 3. Graceful shutdown
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelStop()
	_ = r.Close(stopCtx)
	pm.StopAll(stopCtx)

	if inst.Status().State != process.StateStopped {
		t.Errorf("Expected StateStopped, got: %s", inst.Status().State)
	}
}

// Security Test I: MCP process crash does not crash Edge
// Verifies that an unexpected child process crash is handled gracefully without panicking Edge.
func TestSecurity_ProcessCrashDoesNotCrashEdge(t *testing.T) {
	tempDir := t.TempDir()
	fakeMCPBinary := filepath.Join(tempDir, "fake-crash-mcp.exe")

	buildCmd := exec.Command("go", "build", "-o", fakeMCPBinary, "./fixtures/fake-mcp/main.go")
	buildCmd.Env = os.Environ()
	buildOut, err := buildCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Failed to build fake-mcp fixture: %v, output: %s", err, string(buildOut))
	}

	// Create manifest with -crash-on-start
	m := &manifest.Manifest{
		ID:             "sap-crash-test",
		Name:           "Crashing SAP ADT MCP",
		Version:        "1.0.0",
		Transport:      "stdio",
		Executable:     fakeMCPBinary,
		Arguments:      []string{"-crash-on-start"},
		StartupTimeout: 2 * time.Second,
		RequestTimeout: 2 * time.Second,
		RestartPolicy: manifest.RestartPolicy{
			MaxRestarts:    1,
			CrashWindow:    10 * time.Second,
			InitialBackoff: 50 * time.Millisecond,
			MaxBackoff:     100 * time.Millisecond,
		},
		AllowedTools: []string{"*"},
	}

	pm := process.NewProcessManager(nil)
	reg := registry.NewRegistry(pm, nil)
	_, err = reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register manifest: %v", err)
	}

	pol := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-crash-test"},
	}, nil)

	r := router.NewRouter(reg, pol, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Calling a crashing MCP must return an error and NOT panic Edge
	_, routeErr := r.Route(ctx, router.CallRequest{
		RequestID: "crash-req-1",
		MCPID:     "sap-crash-test",
		Tool:      "read_abap_class",
	})

	if routeErr == nil {
		t.Fatal("Expected error when routing to crashing MCP, got nil")
	}

	// Verify instance state is tracked as crashed or stopped
	inst, ok := reg.GetInstance("sap-crash-test")
	if !ok {
		t.Fatal("Expected instance in registry")
	}

	status := inst.Status()
	if status.State != process.StateCrashed && status.State != process.StateStopped {
		t.Errorf("Expected instance state to be crashed or stopped, got: %s", status.State)
	}

	// Shutdown router gracefully
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelShutdown()
	_ = r.Close(shutdownCtx)
	pm.StopAll(shutdownCtx)
}

// Security Test J: Real SAP test is opt-in only
// Verifies that TestRealSAPADTMCPIntegration skips cleanly when TRUEAI_TEST_REAL_SAP is not set.
func TestSecurity_RealSAPTestIsOptInOnly(t *testing.T) {
	originalVal := os.Getenv("TRUEAI_TEST_REAL_SAP")
	defer os.Setenv("TRUEAI_TEST_REAL_SAP", originalVal)

	// Ensure variable is unset or not "1"
	os.Setenv("TRUEAI_TEST_REAL_SAP", "")

	// Run go test specifically targeting TestRealSAPADTMCPIntegration
	cmd := exec.Command("go", "test", "-v", "-run", "^TestRealSAPADTMCPIntegration$", ".")
	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf

	err := cmd.Run()
	output := outBuf.String()
	if err != nil {
		// On Windows, go test cleanup (unlinkat) can occasionally return error if virus scanner holds the temp binary
		if !(strings.Contains(output, "PASS") && strings.Contains(output, "unlinkat")) {
			t.Fatalf("go test failed: %v, output:\n%s", err, output)
		}
	}

	if !strings.Contains(output, "SKIP") {
		t.Errorf("Expected TestRealSAPADTMCPIntegration to SKIP when TRUEAI_TEST_REAL_SAP is unset, output:\n%s", output)
	}
}


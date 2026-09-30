package tests

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/mcp/router"
	"github.com/trueai/edge-connector/internal/policy"
	"github.com/trueai/edge-connector/internal/runtime"
)

// TestEmbeddedHostE2E verifies that the embedded ADT MCP host (sap-adt-host.exe)
// can be extracted, executed in a clean environment (no Node/npm), and support full
// MCP operations (initialize, tools/list with 206 tools parity, tools/call) through Edge.
func TestEmbeddedHostE2E(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("Skipping TestEmbeddedHostE2E: no embedded host binary present")
	}

	// 1. Verify extraction and SHA-256 integrity
	tmpDir := t.TempDir()
	extractedPath, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("Failed to extract embedded host: %v", err)
	}

	fi, err := os.Stat(extractedPath)
	if err != nil || fi.Size() == 0 {
		t.Fatalf("Extracted executable invalid or empty: %v", err)
	}

	expectedSHA := runtime.EmbeddedSHA256()
	actualSHA, err := runtime.FileSHA256(extractedPath)
	if err != nil || actualSHA != expectedSHA {
		t.Fatalf("SHA-256 mismatch: expected %s, got %s", expectedSHA, actualSHA)
	}

	// 2. Locate DEV.env for live or local SAP parameters
	envCandidates := []string{
		filepath.Join("..", "..", "mcp-abap-adt", "DEV.env"),
		filepath.Join("..", "mcp-abap-adt", "DEV.env"),
	}
	envPath := ""
	for _, c := range envCandidates {
		abs, err := filepath.Abs(c)
		if err == nil {
			if _, err := os.Stat(abs); err == nil {
				envPath = abs
				break
			}
		}
	}
	if envPath == "" {
		t.Skip("Skipping live host invocation: DEV.env not found in candidate paths")
	}

	// 3. Build Manifest targeting the extracted host
	m := &manifest.Manifest{
		ID:             "embedded-sap-adt",
		Name:           "Embedded SAP ABAP ADT MCP Host",
		Version:        "1.0.0",
		Transport:      "stdio",
		Executable:     extractedPath,
		EnvPath:        envPath,
		SystemType:     "onprem",
		Arguments:      []string{"--transport=stdio"},
		StartupTimeout: 30 * time.Second,
		RequestTimeout: 60 * time.Second,
		RestartPolicy: manifest.RestartPolicy{
			MaxRestarts:    1,
			CrashWindow:    30 * time.Second,
			InitialBackoff: 500 * time.Millisecond,
			MaxBackoff:     2 * time.Second,
		},
		AllowedTools: []string{"*"},
	}

	// 4. Initialize supervisor with clean PATH (no Node/npm)
	cleanPath := "C:\\Windows\\System32;C:\\Windows"
	m.Env = map[string]string{
		"PATH": cleanPath,
	}

	logger := logging.NewLogger(os.Stderr, "debug", false)
	pm := process.NewProcessManager(logger)
	reg := registry.NewRegistry(pm, logger)

	inst, err := reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register manifest: %v", err)
	}

	// 5. Verify process startup & MCP initialize
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	if err := inst.Start(ctx); err != nil {
		t.Fatalf("Failed to start embedded host process: %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopCancel()
		_ = inst.Stop(stopCtx)
	}()

	st := inst.Status()
	if st.State != process.StateRunning {
		t.Fatalf("Expected process state 'running', got '%s'", st.State)
	}
	t.Logf("Embedded host started with PID: %d", st.PID)

	// 6. Verify tools/list and exact tool count parity (206 tools)
	tools := inst.Tools()
	t.Logf("Discovered tools count: %d", len(tools))
	if len(tools) != 206 {
		t.Errorf("Expected exactly 206 tools for onprem exposition, got %d", len(tools))
	}

	hasGetObjectsList := false
	hasGetPackage := false
	for _, tool := range tools {
		if tool.Name == "GetObjectsList" {
			hasGetObjectsList = true
		}
		if tool.Name == "GetPackage" {
			hasGetPackage = true
		}
	}
	if !hasGetObjectsList {
		t.Error("Expected GetObjectsList to be in discovered tools")
	}
	if !hasGetPackage {
		t.Error("Expected GetPackage to be in discovered tools")
	}

	// 7. Verify tools/call execution through router
	pol := policy.NewEngine(policy.Config{
		AllowedMCPs:    []string{"embedded-sap-adt"},
		DefaultTimeout: 45 * time.Second,
	}, logger)
	mcpRouter := router.NewRouter(reg, pol, logger)

	callReq := router.CallRequest{
		RequestID: "test-call-getpackage-1",
		MCPID:     "embedded-sap-adt",
		Tool:      "GetPackage",
		Arguments: map[string]interface{}{
			"package_name": "BASIS",
		},
	}

	resp, err := mcpRouter.Route(ctx, callReq)
	if err != nil {
		t.Fatalf("Failed to route tool call: %v", err)
	}

	t.Logf("Tool call response received (isError=%v, duration=%v)", resp.IsError, resp.Duration)

	// 8. Verify No Credential Leakage in response
	var responseText strings.Builder
	if resp.Result != nil {
		for _, c := range resp.Result.Content {
			responseText.WriteString(c.Text)
		}
	}
	rawResp := responseText.String()
	t.Logf("Tool response payload preview: %s", rawResp)

	forbiddenStrings := []string{
		"password",
		"SAP_PASSWORD",
		"SAP_USER",
		"serviceUrl",
	}
	for _, forbidden := range forbiddenStrings {
		if strings.Contains(strings.ToLower(rawResp), strings.ToLower(forbidden)) {
			t.Errorf("CRITICAL SECURITY VIOLATION: response leaked credential term: %s", forbidden)
		}
	}
}

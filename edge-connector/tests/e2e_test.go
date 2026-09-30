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

func TestEdgeConnectorE2EWithFakeMCP(t *testing.T) {
	// Build the fake-mcp binary in a temp directory
	tempDir := t.TempDir()
	fakeMCPBinary := filepath.Join(tempDir, "fake-mcp.exe")

	buildCmd := exec.Command("go", "build", "-o", fakeMCPBinary, "./fixtures/fake-mcp/main.go")
	buildCmd.Env = os.Environ()
	buildOut, err := buildCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Failed to build fake-mcp fixture: %v, output: %s", err, string(buildOut))
	}

	// 1. Prepare Manifest for Fake MCP
	m := &manifest.Manifest{
		ID:         "sap-adt",
		Name:       "Simulated SAP ADT MCP",
		Version:    "1.0.0",
		Transport:  "stdio",
		Executable: fakeMCPBinary,
		Arguments:  []string{},
		StartupTimeout: 10 * time.Second,
		RequestTimeout: 10 * time.Second,
		RestartPolicy: manifest.RestartPolicy{
			MaxRestarts:    3,
			CrashWindow:    30 * time.Second,
			InitialBackoff: 100 * time.Millisecond,
			MaxBackoff:     1 * time.Second,
		},
		AllowedTools: []string{"read_abap_class", "list_packages"},
	}

	// 2. Initialize Edge Components
	pm := process.NewProcessManager(nil)
	reg := registry.NewRegistry(pm, nil)

	_, err = reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("Failed to register manifest: %v", err)
	}

	pol := policy.NewEngine(policy.Config{
		AllowedMCPs: []string{"sap-adt"},
		AllowedTools: map[string][]string{
			"sap-adt": {"read_abap_class", "list_packages"},
		},
	}, nil)

	r := router.NewRouter(reg, pol, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 3. E2E Tool Call: read_abap_class
	callReq := router.CallRequest{
		RequestID: "e2e-req-1",
		MCPID:     "sap-adt",
		Tool:      "read_abap_class",
		Arguments: map[string]interface{}{
			"class_name": "ZCL_CUSTOMER_INVOICE",
		},
	}

	resp, err := r.Route(ctx, callReq)
	if err != nil {
		t.Fatalf("Route tool call failed: %v", err)
	}

	if resp.IsError {
		t.Errorf("Expected successful response, got isError=true")
	}
	if len(resp.Result.Content) == 0 {
		t.Fatalf("Expected content in tool response, got none")
	}

	contentText := resp.Result.Content[0].Text
	if !strings.Contains(contentText, "ZCL_CUSTOMER_INVOICE") {
		t.Errorf("Expected content to contain 'ZCL_CUSTOMER_INVOICE', got: %s", contentText)
	}

	// 4. E2E Tool Call: list_packages
	pkgReq := router.CallRequest{
		RequestID: "e2e-req-2",
		MCPID:     "sap-adt",
		Tool:      "list_packages",
		Arguments: map[string]interface{}{},
	}
	pkgResp, err := r.Route(ctx, pkgReq)
	if err != nil {
		t.Fatalf("Route list_packages failed: %v", err)
	}
	if !strings.Contains(pkgResp.Result.Content[0].Text, "Z_FINANCE") {
		t.Errorf("Expected list_packages to contain Z_FINANCE, got: %s", pkgResp.Result.Content[0].Text)
	}

	// 5. Verify Policy Rejection: Unknown MCP
	_, err = r.Route(ctx, router.CallRequest{
		RequestID: "e2e-req-3",
		MCPID:     "unauthorized-mcp",
		Tool:      "read_abap_class",
	})
	if err == nil {
		t.Fatal("Expected error for unauthorized-mcp, got nil")
	}

	// 6. Verify Policy Rejection: Unknown Tool
	_, err = r.Route(ctx, router.CallRequest{
		RequestID: "e2e-req-4",
		MCPID:     "sap-adt",
		Tool:      "delete_all_abap_code",
	})
	if err == nil {
		t.Fatal("Expected error for delete_all_abap_code, got nil")
	}

	// 7. Verify Policy Rejection: Arbitrary Process Execution Parameters
	_, err = r.Route(ctx, router.CallRequest{
		RequestID: "e2e-req-5",
		MCPID:     "sap-adt",
		Tool:      "read_abap_class",
		Arguments: map[string]interface{}{
			"command": "cmd.exe /c calc",
		},
	})
	if err == nil {
		t.Fatal("Expected error for forbidden argument 'command', got nil")
	}

	// 8. Graceful Shutdown
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()

	if err := r.Close(shutdownCtx); err != nil {
		t.Errorf("Router close failed: %v", err)
	}
	pm.StopAll(shutdownCtx)

	inst, ok := reg.GetInstance("sap-adt")
	if !ok {
		t.Fatal("Expected sap-adt instance in registry")
	}
	if inst.Status().State != process.StateStopped {
		t.Errorf("Expected state to be StateStopped after StopAll, got: %v", inst.Status().State)
	}
}


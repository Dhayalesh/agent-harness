package health

import (
	"bytes"
	"strings"
	"testing"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
)

func TestHealthMonitor(t *testing.T) {
	pm := process.NewProcessManager(nil)
	m := &manifest.Manifest{
		ID:            "sap-adt",
		Name:          "SAP ADT MCP",
		Version:       "1.0.0",
		Transport:     "stdio",
		Executable:    "node",
		RestartPolicy: manifest.DefaultRestartPolicy(),
	}

	_, err := pm.Register(m)
	if err != nil {
		t.Fatalf("Register failed: %v", err)
	}

	monitor := NewMonitor(pm, "1.0.0")

	// 1. Initial status before start
	h := monitor.GetHealth()
	if h.Version != "1.0.0" {
		t.Errorf("Expected version 1.0.0, got %s", h.Version)
	}
	if len(h.MCPs) != 1 {
		t.Fatalf("Expected 1 MCP in health report, got %d", len(h.MCPs))
	}
	if h.MCPs["sap-adt"].State != process.StateStopped {
		t.Errorf("Expected sap-adt state 'stopped', got %s", h.MCPs["sap-adt"].State)
	}

	// 2. Format summary
	buf := &bytes.Buffer{}
	if err := monitor.FormatSummary(buf); err != nil {
		t.Fatalf("FormatSummary failed: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "sap-adt") || !strings.Contains(out, "stopped") {
		t.Errorf("Unexpected summary output: %s", out)
	}

	// 3. Format JSON
	jsonBytes, err := monitor.FormatJSON()
	if err != nil {
		t.Fatalf("FormatJSON failed: %v", err)
	}
	if !strings.Contains(string(jsonBytes), `"status"`) {
		t.Errorf("Expected valid json output, got: %s", string(jsonBytes))
	}
}


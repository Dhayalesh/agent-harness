package registry

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
)

func TestRegistryOperations(t *testing.T) {
	pm := process.NewProcessManager(nil)
	reg := NewRegistry(pm, nil)

	m := &manifest.Manifest{
		ID:            "sap-adt",
		Name:          "SAP ADT MCP",
		Version:       "1.0.0",
		Transport:     "stdio",
		Executable:    "node",
		RestartPolicy: manifest.DefaultRestartPolicy(),
	}

	// 1. Register manifest
	inst, err := reg.RegisterManifest(m)
	if err != nil {
		t.Fatalf("RegisterManifest failed: %v", err)
	}
	if inst == nil {
		t.Fatal("Expected non-nil instance returned from registration")
	}

	// 2. Duplicate registration rejection
	_, err = reg.RegisterManifest(m)
	if err == nil {
		t.Fatal("Expected error registering duplicate manifest ID, got nil")
	}

	// 3. Lookup
	gotM, ok := reg.GetManifest("sap-adt")
	if !ok || gotM.ID != "sap-adt" {
		t.Fatalf("GetManifest failed or returned incorrect ID")
	}

	gotInst, ok := reg.GetInstance("sap-adt")
	if !ok || gotInst != inst {
		t.Fatalf("GetInstance failed to return matching instance")
	}

	// 4. List manifests
	list := reg.ListManifests()
	if len(list) != 1 || list[0].ID != "sap-adt" {
		t.Fatalf("ListManifests mismatch: %v", list)
	}
}

func TestLoadManifestsDir(t *testing.T) {
	pm := process.NewProcessManager(nil)
	reg := NewRegistry(pm, nil)

	tmpDir := t.TempDir()
	manifestFile := filepath.Join(tmpDir, "sap-adt.yaml")
	content := `
id: sap-adt
name: SAP ADT
version: 1.0.0
transport: stdio
executable: node
`
	if err := os.WriteFile(manifestFile, []byte(content), 0600); err != nil {
		t.Fatalf("Failed to write test manifest file: %v", err)
	}

	if err := reg.LoadManifestsDir(tmpDir); err != nil {
		t.Fatalf("LoadManifestsDir failed: %v", err)
	}

	if _, ok := reg.GetManifest("sap-adt"); !ok {
		t.Fatalf("Expected sap-adt manifest to be loaded from directory")
	}
}


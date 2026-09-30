package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseYAMLManifest(t *testing.T) {
	yamlContent := `
id: sap-adt
name: SAP ABAP ADT MCP
version: 1.0.0
transport: stdio
executable: mcp-abap-adt
destination: DEV
arguments:
  - "--transport=stdio"
startupTimeout: 20s
requestTimeout: 45s
restartPolicy:
  maxRestarts: 3
  crashWindow: 30s
  initialBackoff: 2s
  maxBackoff: 25s
allowedTools:
  - read_abap_class
  - list_packages
`
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "sap-adt.yaml")
	if err := os.WriteFile(filePath, []byte(yamlContent), 0600); err != nil {
		t.Fatalf("Failed to write test yaml: %v", err)
	}

	m, err := LoadFromFile(filePath)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if m.ID != "sap-adt" {
		t.Errorf("Expected ID 'sap-adt', got %s", m.ID)
	}
	if m.Name != "SAP ABAP ADT MCP" {
		t.Errorf("Expected Name 'SAP ABAP ADT MCP', got %s", m.Name)
	}
	if m.Executable != "mcp-abap-adt" {
		t.Errorf("Expected Executable 'mcp-abap-adt', got %s", m.Executable)
	}
	if m.Destination != "DEV" {
		t.Errorf("Expected Destination 'DEV', got %s", m.Destination)
	}
	if len(m.Arguments) != 1 || m.Arguments[0] != "--transport=stdio" {
		t.Errorf("Unexpected arguments: %v", m.Arguments)
	}

	// Test EffectiveArguments merges --mcp=DEV
	effArgs := m.EffectiveArguments()
	expectedArgs := []string{"--transport=stdio", "--mcp=DEV"}
	if len(effArgs) != len(expectedArgs) {
		t.Fatalf("Unexpected effective arguments count: got %v, want %v", effArgs, expectedArgs)
	}
	for i, arg := range expectedArgs {
		if effArgs[i] != arg {
			t.Errorf("Effective argument %d mismatch: got %s, want %s", i, effArgs[i], arg)
		}
	}

	// Test EffectiveEnv does NOT inject unverified SAP_DESTINATION
	effEnv := m.EffectiveEnv()
	if _, exists := effEnv["SAP_DESTINATION"]; exists {
		t.Errorf("EffectiveEnv should not automatically inject SAP_DESTINATION, found %v", effEnv["SAP_DESTINATION"])
	}

	if m.StartupTimeout != 20*time.Second {
		t.Errorf("Expected startup timeout 20s, got %v", m.StartupTimeout)
	}
	if m.RequestTimeout != 45*time.Second {
		t.Errorf("Expected request timeout 45s, got %v", m.RequestTimeout)
	}
	if m.RestartPolicy.MaxRestarts != 3 {
		t.Errorf("Expected maxRestarts 3, got %d", m.RestartPolicy.MaxRestarts)
	}
	if m.RestartPolicy.CrashWindow != 30*time.Second {
		t.Errorf("Expected crashWindow 30s, got %v", m.RestartPolicy.CrashWindow)
	}
	if len(m.AllowedTools) != 2 || m.AllowedTools[0] != "read_abap_class" {
		t.Errorf("Unexpected allowed tools: %v", m.AllowedTools)
	}
}

func TestParseYAMLManifest_WithEnvPathAndSystemType(t *testing.T) {
	yamlContent := `
id: sap-adt
name: SAP ABAP ADT MCP
version: 1.0.0
transport: stdio
executable: mcp-abap-adt
systemType: onprem
envPath: .\DEV.env
arguments:
  - "--transport=stdio"
`
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "sap-adt.yaml")
	if err := os.WriteFile(filePath, []byte(yamlContent), 0600); err != nil {
		t.Fatalf("Failed to write test yaml: %v", err)
	}

	m, err := LoadFromFile(filePath)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if m.SystemType != "onprem" {
		t.Errorf("Expected SystemType 'onprem', got %s", m.SystemType)
	}
	if m.EnvPath != `.\DEV.env` {
		t.Errorf("Expected EnvPath '.\\DEV.env', got %s", m.EnvPath)
	}

	resolvedPath := m.ResolveEnvPath()
	if !filepath.IsAbs(resolvedPath) || !strings.HasSuffix(resolvedPath, "DEV.env") {
		t.Errorf("Expected ResolveEnvPath to return absolute path ending in DEV.env, got: %s", resolvedPath)
	}

	effArgs := m.EffectiveArguments()
	expectedArgs := []string{
		"--transport=stdio",
		"--env-path=" + resolvedPath,
		"--system-type=onprem",
	}
	if len(effArgs) != len(expectedArgs) {
		t.Fatalf("Unexpected effective arguments: got %v, want %v", effArgs, expectedArgs)
	}
	for i, arg := range expectedArgs {
		if effArgs[i] != arg {
			t.Errorf("Effective argument %d mismatch: got %s, want %s", i, effArgs[i], arg)
		}
	}
}

func TestParseYAMLManifest_WithEnvFileAliasAndAbsoluteWindowsPath(t *testing.T) {
	yamlContent := `
id: sap-adt
name: SAP ABAP ADT MCP
version: 1.0.0
transport: stdio
executable: mcp-abap-adt
systemType: onprem
envFile: C:\configs\DEV.env
arguments:
  - "--transport=stdio"
`
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "sap-adt-abs.yaml")
	if err := os.WriteFile(filePath, []byte(yamlContent), 0600); err != nil {
		t.Fatalf("Failed to write test yaml: %v", err)
	}

	m, err := LoadFromFile(filePath)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if m.EnvPath != `C:\configs\DEV.env` {
		t.Errorf("Expected EnvPath 'C:\\configs\\DEV.env', got %s", m.EnvPath)
	}

	resolvedPath := m.ResolveEnvPath()
	if resolvedPath != `C:\configs\DEV.env` {
		t.Errorf("Expected ResolveEnvPath to preserve absolute path 'C:\\configs\\DEV.env', got: %s", resolvedPath)
	}

	effArgs := m.EffectiveArguments()
	hasTransport := false
	hasEnvPath := false
	hasSystemType := false
	for _, arg := range effArgs {
		if arg == "--transport=stdio" {
			hasTransport = true
		}
		if arg == `--env-path=C:\configs\DEV.env` {
			hasEnvPath = true
		}
		if arg == "--system-type=onprem" {
			hasSystemType = true
		}
	}

	if !hasTransport || !hasEnvPath || !hasSystemType {
		t.Errorf("Missing expected arguments in effArgs: %v", effArgs)
	}
}

func TestManifestValidationFailures(t *testing.T) {
	tests := []struct {
		name    string
		m       Manifest
		wantErr bool
	}{
		{
			name: "empty id",
			m: Manifest{
				ID:         "",
				Executable: "node",
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "invalid id chars",
			m: Manifest{
				ID:         "sap;rm -rf",
				Executable: "node",
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "invalid destination chars",
			m: Manifest{
				ID:          "sap-adt",
				Destination: "DEV; rm -rf",
				Executable:  "mcp-abap-adt.exe",
				Transport:   "stdio",
			},
			wantErr: true,
		},
		{
			name: "forbidden shell char in executable",
			m: Manifest{
				ID:         "sap-adt",
				Executable: "node | sh",
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "forbidden shell char in argument",
			m: Manifest{
				ID:         "sap-adt",
				Executable: "node",
				Arguments:  []string{"normal.js", "; echo pwned"},
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "forbidden shell char in envPath",
			m: Manifest{
				ID:         "sap-adt",
				Executable: "mcp-abap-adt",
				EnvPath:    "DEV.env; rm -rf",
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "forbidden shell char in systemType",
			m: Manifest{
				ID:         "sap-adt",
				Executable: "mcp-abap-adt",
				SystemType: "onprem | sh",
				Transport:  "stdio",
			},
			wantErr: true,
		},
		{
			name: "unsupported transport",
			m: Manifest{
				ID:         "sap-adt",
				Executable: "node",
				Transport:  "sse",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.m.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
}

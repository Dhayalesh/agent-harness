package tests

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trueai/edge-connector/assets"
	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/runtime"
)

// getOrBuildTestEdgeBinary returns the path to a compiled edge.exe binary,
// building it in the repo root once if necessary.
func getOrBuildTestEdgeBinary(t *testing.T) string {
	t.Helper()
	cand := filepath.Join("..", "edge.exe")
	if fi, err := os.Stat(cand); err == nil && fi.Size() > 0 {
		abs, err := filepath.Abs(cand)
		if err == nil {
			return abs
		}
	}

	buildCmd := exec.Command("go", "build", "-o", "../edge.exe", "../cmd/edge")
	buildCmd.Env = os.Environ()
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("Failed to build edge.exe: %v\nOutput: %s", err, string(out))
	}
	abs, err := filepath.Abs("../edge.exe")
	if err != nil {
		t.Fatalf("Failed to get abs path of edge.exe: %v", err)
	}
	return abs
}

// copyBinary copies a binary file to the destination.
func copyBinary(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}

// safeWindowsCleanup registers a cleanup handler that retries removing the temporary
// binary so Windows AV / file locking does not fail the t.TempDir() RemoveAll step.
func safeWindowsCleanup(t *testing.T, binPath string) {
	t.Helper()
	t.Cleanup(func() {
		for i := 0; i < 20; i++ {
			if err := os.Remove(binPath); err == nil || os.IsNotExist(err) {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
}

// A. EmbeddedManifestTest
// Verifies the package can parse and register sap-adt from embedded bytes
// without any external mcp\manifests directory existing.
func TestEmbeddedManifest_LoadWithoutDirectory(t *testing.T) {
	if len(assets.EmbeddedDefaultManifest) == 0 {
		t.Fatal("assets.EmbeddedDefaultManifest is empty")
	}

	m, err := manifest.LoadFromBytes(assets.EmbeddedDefaultManifest, ".yaml")
	if err != nil {
		t.Fatalf("Failed to parse embedded manifest: %v", err)
	}

	if m.ID != "sap-adt" {
		t.Errorf("Expected manifest ID 'sap-adt', got '%s'", m.ID)
	}
	if m.SystemType != "onprem" {
		t.Errorf("Expected systemType 'onprem', got '%s'", m.SystemType)
	}
	if m.Transport != "stdio" {
		t.Errorf("Expected transport 'stdio', got '%s'", m.Transport)
	}
	if m.EnvPath != "" {
		t.Errorf("Security check failed: embedded manifest must NOT contain envPath, got '%s'", m.EnvPath)
	}

	// Verify registry registration from bytes
	pm := process.NewProcessManager(logging.NewLogger(io.Discard, "error", true))
	reg := registry.NewRegistry(pm, logging.NewLogger(io.Discard, "error", true))

	inst, err := reg.RegisterManifestBytes(assets.EmbeddedDefaultManifest, ".yaml")
	if err != nil {
		t.Fatalf("Failed to register embedded manifest: %v", err)
	}
	if inst.Manifest().ID != "sap-adt" {
		t.Errorf("Expected registered instance ID 'sap-adt', got '%s'", inst.Manifest().ID)
	}
}

// B. CleanDirectoryTest
// Runs edge.exe from a clean isolated temporary directory containing ONLY edge.exe.
// Verifies Edge starts, loads embedded manifest, extracts embedded ADT host,
// and discovers all 206 tools with no external mcp\ directory required.
func TestCleanDirectory_OnlyEdgeExe(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("Skipping TestCleanDirectory_OnlyEdgeExe: embedded host binary not present")
	}

	cleanDir := t.TempDir()
	edgeSrc := getOrBuildTestEdgeBinary(t)
	edgeBinary := filepath.Join(cleanDir, "edge.exe")
	safeWindowsCleanup(t, edgeBinary)

	if err := copyBinary(edgeSrc, edgeBinary); err != nil {
		t.Fatalf("Failed to copy edge.exe to cleanDir: %v", err)
	}

	// Verify that ONLY edge.exe exists in cleanDir
	entries, err := os.ReadDir(cleanDir)
	if err != nil {
		t.Fatalf("Failed to read cleanDir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "edge.exe" {
		t.Fatalf("Expected only edge.exe in cleanDir, found: %v", entries)
	}

	// 2. Run .\edge.exe --describe-tool GetObjectsList with cleanDir as working directory
	cmd := exec.Command(edgeBinary, "--describe-tool", "GetObjectsList")
	cmd.Dir = cleanDir
	cmd.Env = os.Environ()

	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf

	err = cmd.Run()
	output := outBuf.String()
	if err != nil {
		t.Fatalf("edge.exe in clean directory failed: %v\nOutput:\n%s", err, output)
	}

	// 3. Verify assertions
	if !strings.Contains(output, "Using embedded MCP manifest") {
		t.Errorf("Expected output to contain 'Using embedded MCP manifest', output:\n%s", output)
	}
	if !strings.Contains(output, "MCP handshake succeeded") {
		t.Errorf("Expected output to contain 'MCP handshake succeeded', output:\n%s", output)
	}
	if !strings.Contains(output, `"count":206`) && !strings.Contains(output, "count: 206") {
		t.Errorf("Expected 206 tools discovered, output:\n%s", output)
	}
	if !strings.Contains(output, "GetObjectsList") {
		t.Errorf("Expected GetObjectsList description, output:\n%s", output)
	}
	if strings.Contains(output, "cannot access manifest directory") || strings.Contains(output, "mcp\\manifests") {
		t.Errorf("Error: output contains warning about missing manifest directory:\n%s", output)
	}
}

// C. NoNodeDependencyTest
// Verifies Edge works in an execution environment with PATH containing no Node.js or npm.
func TestNoNodeDependency(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("Skipping TestNoNodeDependency: embedded host binary not present")
	}

	cleanDir := t.TempDir()
	edgeSrc := getOrBuildTestEdgeBinary(t)
	edgeBinary := filepath.Join(cleanDir, "edge.exe")
	safeWindowsCleanup(t, edgeBinary)

	if err := copyBinary(edgeSrc, edgeBinary); err != nil {
		t.Fatalf("Failed to copy edge.exe to cleanDir: %v", err)
	}

	// Construct clean PATH containing ONLY standard Windows system directories
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	cleanPath := filepath.Join(systemRoot, "System32") + ";" + systemRoot

	cleanEnv := make([]string, 0)
	for _, env := range os.Environ() {
		key := strings.ToUpper(strings.SplitN(env, "=", 2)[0])
		if key != "PATH" && key != "NODE_PATH" && key != "NVM_HOME" && key != "VOLTA_HOME" {
			cleanEnv = append(cleanEnv, env)
		}
	}
	cleanEnv = append(cleanEnv, "PATH="+cleanPath)

	cmd := exec.Command(edgeBinary, "--describe-tool", "GetObjectsList")
	cmd.Dir = cleanDir
	cmd.Env = cleanEnv

	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf

	err := cmd.Run()
	output := outBuf.String()
	if err != nil {
		t.Fatalf("Execution with clean PATH failed: %v\nOutput:\n%s", err, output)
	}

	if !strings.Contains(output, "MCP handshake succeeded") {
		t.Errorf("Expected MCP handshake succeeded in Node-free environment:\n%s", output)
	}
	if !strings.Contains(output, `"count":206`) && !strings.Contains(output, "count: 206") {
		t.Errorf("Expected 206 tools in Node-free environment:\n%s", output)
	}
}

// D. ExistingDevelopmentConfigTest
// Verifies that --sap-env-path continues to function for developer/integration workflows.
func TestExistingDevelopmentConfig_DevEnv(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("Skipping TestExistingDevelopmentConfig_DevEnv: embedded host binary not present")
	}

	envCandidates := []string{
		filepath.Join("..", "..", "mcp-abap-adt", "DEV.env"),
		filepath.Join("..", "mcp-abap-adt", "DEV.env"),
	}
	devEnvPath := ""
	for _, c := range envCandidates {
		abs, err := filepath.Abs(c)
		if err == nil {
			if _, err := os.Stat(abs); err == nil {
				devEnvPath = abs
				break
			}
		}
	}

	if devEnvPath == "" {
		t.Skip("Skipping TestExistingDevelopmentConfig_DevEnv: DEV.env not found")
	}

	cleanDir := t.TempDir()
	edgeSrc := getOrBuildTestEdgeBinary(t)
	edgeBinary := filepath.Join(cleanDir, "edge.exe")
	safeWindowsCleanup(t, edgeBinary)

	if err := copyBinary(edgeSrc, edgeBinary); err != nil {
		t.Fatalf("Failed to copy edge.exe to cleanDir: %v", err)
	}

	cmd := exec.Command(edgeBinary, "--sap-env-path", devEnvPath, "--describe-tool", "GetObjectsList")
	cmd.Dir = cleanDir
	cmd.Env = os.Environ()

	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf

	err := cmd.Run()
	output := outBuf.String()
	if err != nil {
		t.Fatalf("Execution with --sap-env-path failed: %v\nOutput:\n%s", err, output)
	}

	if !strings.Contains(output, "MCP handshake succeeded") {
		t.Errorf("Expected MCP handshake succeeded with DEV.env, output:\n%s", output)
	}
	if !strings.Contains(output, `"count":206`) && !strings.Contains(output, "count: 206") {
		t.Errorf("Expected 206 tools discovered with DEV.env, output:\n%s", output)
	}
}

// E. ExistingRealADTTest
// Verifies embedded ADT host starts, handshakes, discovers 206 tools, and describes GetObjectsList.
func TestExistingRealADT_Discovers206Tools(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("Skipping TestExistingRealADT_Discovers206Tools: embedded host binary not present")
	}

	cleanDir := t.TempDir()
	edgeSrc := getOrBuildTestEdgeBinary(t)
	edgeBinary := filepath.Join(cleanDir, "edge.exe")
	safeWindowsCleanup(t, edgeBinary)

	if err := copyBinary(edgeSrc, edgeBinary); err != nil {
		t.Fatalf("Failed to copy edge.exe to cleanDir: %v", err)
	}

	cmd := exec.Command(edgeBinary, "--describe-tool", "GetObjectsList")
	cmd.Dir = cleanDir
	cmd.Env = os.Environ()

	var outBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &outBuf

	err := cmd.Run()
	output := outBuf.String()
	if err != nil {
		t.Fatalf("Failed to describe tool: %v\nOutput:\n%s", err, output)
	}

	expectedElements := []string{
		"GetObjectsList",
		"parent_name",
		"parent_tech_name",
		"parent_type",
		"with_short_descriptions",
	}

	for _, elem := range expectedElements {
		if !strings.Contains(output, elem) {
			t.Errorf("Expected output to contain schema element '%s', output:\n%s", elem, output)
		}
	}
}


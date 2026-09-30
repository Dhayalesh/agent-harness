package tests

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCompiledBinaryE2E verifies that the compiled edge.exe binary directly operates
// an external MCP child process (fake-mcp.exe) over stdio.
func TestCompiledBinaryE2E(t *testing.T) {
	tempDir := t.TempDir()

	edgeBinary := filepath.Join(tempDir, "edge.exe")
	fakeMCPBinary := filepath.Join(tempDir, "fake-mcp.exe")

	// 1. Build edge.exe
	buildEdgeCmd := exec.Command("go", "build", "-o", edgeBinary, "../cmd/edge")
	buildEdgeCmd.Env = os.Environ()
	outEdge, err := buildEdgeCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Failed to build edge.exe: %v\nOutput: %s", err, string(outEdge))
	}

	// 2. Build external fake-mcp.exe
	buildMCPCmd := exec.Command("go", "build", "-o", fakeMCPBinary, "./fixtures/fake-mcp")
	buildMCPCmd.Env = os.Environ()
	outMCP, err := buildMCPCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Failed to build fake-mcp.exe: %v\nOutput: %s", err, string(outMCP))
	}

	// 3. Test Full External Process Flow: Startup -> Handshake -> Discovery -> Tool Call -> Clean Exit
	t.Run("ExternalProcess_ToolCallAndShutdown", func(t *testing.T) {
		cmd := exec.Command(
			edgeBinary,
			"--sap-executable", fakeMCPBinary,
			"--destination", "DEV",
			"--call-tool", "read_abap_class",
			"--call-args", `{"class_name":"ZCL_BINARY_TEST"}`,
		)
		cmd.Env = os.Environ()
		var outBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &outBuf

		err := cmd.Run()
		output := outBuf.String()
		if err != nil {
			t.Fatalf("edge.exe execution failed: %v\nOutput:\n%s", err, output)
		}

		// Verify process lifecycle checkpoints
		expectedPatterns := []string{
			"Auto-starting configured default MCP",
			"Starting MCP child process",
			"--transport=stdio",
			"--mcp=DEV",
			"MCP handshake succeeded",
			"Discovered tools dynamically",
			"Executing requested tool call",
			"ZCL_BINARY_TEST",
			"Stopping MCP process gracefully",
			"MCP child process stopped gracefully",
			"Graceful shutdown complete",
		}

		for _, pattern := range expectedPatterns {
			if !strings.Contains(output, pattern) {
				t.Errorf("Expected output to contain '%s', but got:\n%s", pattern, output)
			}
		}
	})

	// 4. Test Process Crash Detection & Supervisor Automatic Restart Recovery
	t.Run("ExternalProcess_CrashDetectionAndRestart", func(t *testing.T) {
		cmd := exec.Command(
			edgeBinary,
			"--sap-executable", fakeMCPBinary,
			"--destination", "DEV",
			"--test-restart",
		)
		cmd.Env = os.Environ()
		var outBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &outBuf

		err := cmd.Run()
		output := outBuf.String()
		if err != nil {
			t.Fatalf("edge.exe --test-restart failed: %v\nOutput:\n%s", err, output)
		}

		expectedPatterns := []string{
			"Starting process supervisor restart verification test",
			"Triggering simulated crash on external child process",
			"MCP process crashed; scheduling restart with backoff",
			"exitCode\":99",
			"Child process successfully recovered and restarted by supervisor",
			"Verifying tool execution on restarted child process",
			"ZCL_AFTER_RESTART",
			"Restart test completed successfully",
		}

		for _, pattern := range expectedPatterns {
			if !strings.Contains(output, pattern) {
				t.Errorf("Expected output to contain '%s', but got:\n%s", pattern, output)
			}
		}
	})

	// 5. Test External MCP Receiving Configured --env-path and --system-type
	t.Run("ExternalProcess_EnvPathAndSystemTypePassing", func(t *testing.T) {
		cmd := exec.Command(
			edgeBinary,
			"--sap-executable", fakeMCPBinary,
			"--sap-env-path", `.\DEV.env`,
			"--sap-system-type", "onprem",
			"--call-tool", "get_mcp_config",
		)
		cmd.Env = os.Environ()
		var outBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &outBuf

		err := cmd.Run()
		output := outBuf.String()
		if err != nil {
			t.Fatalf("edge.exe --call-tool get_mcp_config failed: %v\nOutput:\n%s", err, output)
		}

		expectedPatterns := []string{
			"Starting MCP child process",
			"--transport=stdio",
			"--env-path=",
			"DEV.env",
			"--system-type=onprem",
			"MCP handshake succeeded",
			"Discovered tools dynamically",
			"Executing requested tool call",
			"env-path=",
			"system-type=onprem",
			"Stopping MCP process gracefully",
			"MCP child process stopped gracefully",
			"Graceful shutdown complete",
		}

		for _, pattern := range expectedPatterns {
			if !strings.Contains(output, pattern) {
				t.Errorf("Expected output to contain '%s', but got:\n%s", pattern, output)
			}
		}
	})

	// 6. Test --describe-tool for Printing Tool Schema
	t.Run("ExternalProcess_DescribeTool", func(t *testing.T) {
		cmd := exec.Command(
			edgeBinary,
			"--sap-executable", fakeMCPBinary,
			"--describe-tool", "read_abap_class",
		)
		cmd.Env = os.Environ()
		var outBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &outBuf

		err := cmd.Run()
		output := outBuf.String()
		if err != nil {
			t.Fatalf("edge.exe --describe-tool read_abap_class failed: %v\nOutput:\n%s", err, output)
		}

		expectedPatterns := []string{
			"Name: read_abap_class",
			"Description: Read ABAP OO class definition and implementation from simulated SAP",
			"Input Schema:",
			`"class_name"`,
			`"type": "string"`,
			`"required"`,
			"Graceful shutdown complete",
		}

		for _, pattern := range expectedPatterns {
			if !strings.Contains(output, pattern) {
				t.Errorf("Expected output to contain '%s', but got:\n%s", pattern, output)
			}
		}
	})

	// 7. Test --describe-tool for Non-Existent Tool
	t.Run("ExternalProcess_DescribeTool_NotFound", func(t *testing.T) {
		cmd := exec.Command(
			edgeBinary,
			"--sap-executable", fakeMCPBinary,
			"--describe-tool", "non_existent_tool",
		)
		cmd.Env = os.Environ()
		var outBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &outBuf

		err := cmd.Run()
		if err == nil {
			t.Fatalf("Expected edge.exe --describe-tool non_existent_tool to exit with error, but succeeded")
		}

		output := outBuf.String()
		if !strings.Contains(output, "non_existent_tool") || !strings.Contains(output, "not found") {
			t.Errorf("Expected output to indicate tool not found, got:\n%s", output)
		}
	})
}

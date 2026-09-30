package runtime_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/trueai/edge-connector/internal/runtime"
)

func TestEmbeddedHost_Presence(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Fatal("Expected embedded host binary to be present, but was empty")
	}

	sha := runtime.EmbeddedSHA256()
	if len(sha) != 64 {
		t.Fatalf("Expected 64-char SHA256 hex string, got: %s", sha)
	}
	t.Logf("Embedded host SHA-256: %s", sha)
}

func TestEmbeddedHost_Extraction(t *testing.T) {
	tmpDir := t.TempDir()

	targetPath, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("EnsureExtractedTo failed: %v", err)
	}

	expectedPath := filepath.Join(tmpDir, "sap-adt-host.exe")
	if targetPath != expectedPath {
		t.Fatalf("Expected target path %s, got %s", expectedPath, targetPath)
	}

	fi, err := os.Stat(targetPath)
	if err != nil {
		t.Fatalf("Target file does not exist: %v", err)
	}

	if fi.Size() == 0 {
		t.Fatalf("Extracted file has size 0")
	}

	fileSHA, err := runtime.FileSHA256(targetPath)
	if err != nil {
		t.Fatalf("Failed to calculate extracted file SHA: %v", err)
	}

	if fileSHA != runtime.EmbeddedSHA256() {
		t.Fatalf("Extracted file SHA mismatch: expected %s, got %s", runtime.EmbeddedSHA256(), fileSHA)
	}
}

func TestEmbeddedHost_FastPath(t *testing.T) {
	tmpDir := t.TempDir()

	// Initial extraction
	targetPath, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("Initial extraction failed: %v", err)
	}

	fiBefore, err := os.Stat(targetPath)
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}

	// Second extraction should hit fast-path (zero write)
	targetPath2, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("Second extraction failed: %v", err)
	}

	if targetPath2 != targetPath {
		t.Fatalf("Path mismatch on fast path: %s vs %s", targetPath, targetPath2)
	}

	fiAfter, err := os.Stat(targetPath)
	if err != nil {
		t.Fatalf("Stat after second call failed: %v", err)
	}

	if fiBefore.ModTime() != fiAfter.ModTime() {
		t.Fatalf("ModTime changed: fast path was not taken")
	}
}

func TestEmbeddedHost_TamperRecovery(t *testing.T) {
	tmpDir := t.TempDir()

	targetPath, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("Initial extraction failed: %v", err)
	}

	// Tamper with file
	if err := os.WriteFile(targetPath, []byte("tampered content"), 0644); err != nil {
		t.Fatalf("Failed to tamper file: %v", err)
	}

	tamperedSHA, _ := runtime.FileSHA256(targetPath)
	if tamperedSHA == runtime.EmbeddedSHA256() {
		t.Fatal("Expected tampered SHA to differ")
	}

	// EnsureExtractedTo should detect hash mismatch and overwrite with authentic binary
	recoveredPath, err := runtime.EnsureExtractedTo(tmpDir)
	if err != nil {
		t.Fatalf("Recovery extraction failed: %v", err)
	}

	recoveredSHA, err := runtime.FileSHA256(recoveredPath)
	if err != nil {
		t.Fatalf("Failed to calculate recovered SHA: %v", err)
	}

	if recoveredSHA != runtime.EmbeddedSHA256() {
		t.Fatalf("Recovered file SHA mismatch: expected %s, got %s", runtime.EmbeddedSHA256(), recoveredSHA)
	}
}


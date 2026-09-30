package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/trueai/edge-connector/assets"
)

var (
	// ErrNoEmbeddedBinary is returned when the embedded binary slice is empty.
	ErrNoEmbeddedBinary = errors.New("runtime: no embedded SAP ADT host binary available")

	// cachedEmbeddedSHA256 caches the hash of the embedded slice.
	cachedEmbeddedSHA256 string
	shaOnce              sync.Once

	// extractMu prevents concurrent extractions in the same process.
	extractMu sync.Mutex
)

// HasEmbeddedHost returns true if a non-empty host binary is embedded.
func HasEmbeddedHost() bool {
	return len(assets.EmbeddedHostBinary) > 0
}

// EmbeddedSHA256 returns the hexadecimal SHA-256 digest of the embedded binary.
func EmbeddedSHA256() string {
	shaOnce.Do(func() {
		if len(assets.EmbeddedHostBinary) == 0 {
			cachedEmbeddedSHA256 = ""
			return
		}
		hash := sha256.Sum256(assets.EmbeddedHostBinary)
		cachedEmbeddedSHA256 = hex.EncodeToString(hash[:])
	})
	return cachedEmbeddedSHA256
}

// FileSHA256 calculates the SHA-256 digest of an on-disk file.
func FileSHA256(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// DefaultRuntimeDir returns the target runtime directory in %LOCALAPPDATA%\TrueAI\Edge\runtime.
func DefaultRuntimeDir() (string, error) {
	localApp := os.Getenv("LOCALAPPDATA")
	if localApp != "" {
		return filepath.Join(localApp, "TrueAI", "Edge", "runtime"), nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("runtime: cannot resolve user home directory: %w", err)
	}
	return filepath.Join(home, ".trueai", "edge", "runtime"), nil
}

// ExtractedPath returns the path to the expected extracted sap-adt-host.exe.
func ExtractedPath() (string, error) {
	dir, err := DefaultRuntimeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "sap-adt-host.exe"), nil
}

// EnsureExtracted extracts the embedded host binary to the default runtime directory
// if not already present or if the hash has changed.
func EnsureExtracted() (string, error) {
	dir, err := DefaultRuntimeDir()
	if err != nil {
		return "", err
	}
	return EnsureExtractedTo(dir)
}

// EnsureExtractedTo extracts the embedded host binary to a specific target directory.
// It verifies SHA-256, skips writing if the hash matches, and writes atomically using
// a temporary file + rename to prevent race conditions or corrupted partial writes.
func EnsureExtractedTo(targetDir string) (string, error) {
	if !HasEmbeddedHost() {
		return "", ErrNoEmbeddedBinary
	}

	extractMu.Lock()
	defer extractMu.Unlock()

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", fmt.Errorf("runtime: failed to create runtime directory %s: %w", targetDir, err)
	}

	targetPath := filepath.Join(targetDir, "sap-adt-host.exe")
	expectedSHA := EmbeddedSHA256()

	// Check if already extracted with matching hash
	if fi, err := os.Stat(targetPath); err == nil && !fi.IsDir() {
		existingSHA, err := FileSHA256(targetPath)
		if err == nil && existingSHA == expectedSHA {
			// Fast path: file already exists and hash matches exactly
			return targetPath, nil
		}
	}

	// Atomic extraction: write to temporary file first
	tmpPattern := fmt.Sprintf("sap-adt-host.tmp.%d.*.exe", os.Getpid())
	tmpFile, err := os.CreateTemp(targetDir, tmpPattern)
	if err != nil {
		return "", fmt.Errorf("runtime: failed to create temporary extraction file: %w", err)
	}
	tmpPath := tmpFile.Name()

	cleanup := true
	defer func() {
		if cleanup {
			tmpFile.Close()
			os.Remove(tmpPath)
		}
	}()

	if _, err := tmpFile.Write(assets.EmbeddedHostBinary); err != nil {
		return "", fmt.Errorf("runtime: failed to write embedded binary to %s: %w", tmpPath, err)
	}

	if err := tmpFile.Sync(); err != nil {
		return "", fmt.Errorf("runtime: failed to sync file %s: %w", tmpPath, err)
	}

	if err := tmpFile.Close(); err != nil {
		return "", fmt.Errorf("runtime: failed to close file %s: %w", tmpPath, err)
	}

	// Verify the written temporary file hash matches
	writtenSHA, err := FileSHA256(tmpPath)
	if err != nil {
		return "", fmt.Errorf("runtime: failed to verify written temporary file hash: %w", err)
	}
	if writtenSHA != expectedSHA {
		return "", fmt.Errorf("runtime: written hash mismatch: expected %s, got %s", expectedSHA, writtenSHA)
	}

	// Atomic rename to target path. On Windows, if targetPath exists and is open, Rename fails.
	// Try os.Rename, or remove and rename.
	if err := os.Rename(tmpPath, targetPath); err != nil {
		// Attempt removing existing file if rename failed
		_ = os.Remove(targetPath)
		if errRetry := os.Rename(tmpPath, targetPath); errRetry != nil {
			return "", fmt.Errorf("runtime: failed to atomically install %s: %w", targetPath, errRetry)
		}
	}

	cleanup = false // Successfully installed
	return targetPath, nil
}


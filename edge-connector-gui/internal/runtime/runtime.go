package runtime

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// The build script places the unmodified upstream PyInstaller executable here.
//
//go:embed sapgui_mcp_windows.exe
var upstream embed.FS

var extractMu sync.Mutex

func EmbeddedHash() (string, error) {
	b, err := upstream.ReadFile("sapgui_mcp_windows.exe")
	if err != nil || len(b) == 0 {
		return "", errors.New("upstream sapgui.mcp executable is not embedded")
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func fileHash(path string) (string, error) {
	f, err := os.Open(path)
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

// EnsureExtracted installs a hash-checked runtime beneath EdgeGUI/runtime.
func EnsureExtracted(root string) (string, error) {
	extractMu.Lock()
	defer extractMu.Unlock()
	b, err := upstream.ReadFile("sapgui_mcp_windows.exe")
	if err != nil || len(b) == 0 {
		return "", errors.New("upstream sapgui.mcp executable is not embedded")
	}
	h := sha256.Sum256(b)
	sha := hex.EncodeToString(h[:])
	dir := filepath.Join(root, "runtime", sha[:16])
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	target := filepath.Join(dir, "sapgui-mcp.exe")
	if got, err := fileHash(target); err == nil && got == sha {
		return target, nil
	}
	f, err := os.CreateTemp(dir, "sapgui-mcp-*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return "", err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if got, err := fileHash(f.Name()); err != nil || got != sha {
		return "", fmt.Errorf("embedded runtime verification failed: %v", err)
	}
	if err := os.Rename(f.Name(), target); err != nil {
		if removeErr := os.Remove(target); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return "", removeErr
		}
		if err = os.Rename(f.Name(), target); err != nil {
			return "", err
		}
	}
	return target, nil
}

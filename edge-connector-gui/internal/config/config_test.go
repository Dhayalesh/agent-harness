package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFirstRunAndPersistedDevice(t *testing.T) {
	root := t.TempDir()
	_, err := Load(root)
	if !errors.Is(err, ErrSetupRequired) {
		t.Fatalf("first run: %v", err)
	}
	path := filepath.Join(root, "config.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.DeviceID == "" || cfg.MCPID != MCPID {
		t.Fatalf("generated config: %+v", cfg)
	}
	firstID := cfg.DeviceID
	cfg.Email = "gui@example.com"
	updated, _ := json.Marshal(cfg)
	if err := os.WriteFile(path, updated, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DeviceID != firstID {
		t.Fatal("device ID changed")
	}
	if _, err := os.Stat(filepath.Join(root, "runtime")); err != nil {
		t.Fatal(err)
	}
}

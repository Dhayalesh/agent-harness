package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaultConfig(t *testing.T) {
	cfg := NewDefaultConfig()
	if cfg == nil {
		t.Fatal("Expected default config to be non-nil")
	}

	if cfg.LogLevel != "info" {
		t.Errorf("Expected default log level 'info', got %s", cfg.LogLevel)
	}

	if cfg.Destination != "DEV" {
		t.Errorf("Expected default destination 'DEV', got %s", cfg.Destination)
	}

	if cfg.ShutdownTimeout != DefaultShutdownTimeout {
		t.Errorf("Expected default shutdown timeout %v, got %v", DefaultShutdownTimeout, cfg.ShutdownTimeout)
	}

	if err := cfg.Validate(); err != nil {
		t.Fatalf("Default config failed validation: %v", err)
	}
}

func TestConfigLoadWithOverrides(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "config.json")

	content := `{
		"manifestDir": "custom/manifests",
		"stateDir": "` + filepath.ToSlash(filepath.Join(tmpDir, "state")) + `",
		"logDir": "` + filepath.ToSlash(filepath.Join(tmpDir, "logs")) + `",
		"logLevel": "debug",
		"logJSON": false,
		"destination": "PROD",
		"shutdownTimeout": 5000000000,
		"defaultRequestTimeout": 10000000000,
		"maxResponseSizeBytes": 5242880
	}`

	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("Failed to write test config file: %v", err)
	}

	cfg, err := LoadConfig(configPath)
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	if cfg.ManifestDir != "custom/manifests" {
		t.Errorf("Expected custom manifest dir, got %s", cfg.ManifestDir)
	}
	if cfg.Destination != "PROD" {
		t.Errorf("Expected destination 'PROD', got %s", cfg.Destination)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("Expected log level 'debug', got %s", cfg.LogLevel)
	}
	if cfg.LogJSON != false {
		t.Errorf("Expected logJSON false, got %v", cfg.LogJSON)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Errorf("Expected shutdown timeout 5s, got %v", cfg.ShutdownTimeout)
	}
	if cfg.MaxResponseSizeBytes != 5242880 {
		t.Errorf("Expected max response size 5242880, got %d", cfg.MaxResponseSizeBytes)
	}

	if err := cfg.EnsureDirectories(); err != nil {
		t.Fatalf("EnsureDirectories failed: %v", err)
	}

	if _, err := os.Stat(cfg.StateDir); os.IsNotExist(err) {
		t.Errorf("State directory was not created: %s", cfg.StateDir)
	}
	if _, err := os.Stat(cfg.LogDir); os.IsNotExist(err) {
		t.Errorf("Log directory was not created: %s", cfg.LogDir)
	}
}

func TestConfigSecurityValidation(t *testing.T) {
	cfg := NewDefaultConfig()
	cfg.StateDir = `C:\Windows\System32\TrueAI`

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Expected validation error when stateDir points to C:\\Windows, got nil")
	}

	if !strings.Contains(err.Error(), "security violation") {
		t.Errorf("Expected security violation error, got %v", err)
	}

	// Test invalid destination
	cfg2 := NewDefaultConfig()
	cfg2.Destination = "DEV; rm -rf"
	if err := cfg2.Validate(); err == nil {
		t.Fatal("Expected validation error for invalid destination, got nil")
	}
}

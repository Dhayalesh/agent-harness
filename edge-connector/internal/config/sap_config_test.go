package config

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestSAPConfig_Validation(t *testing.T) {
	valid := &SAPConfig{
		URL:        "https://vhcalnplci:44300",
		Client:     "100",
		AuthType:   "basic",
		Username:   "DEVELOPER",
		SystemType: "onprem",
	}

	if err := valid.Validate(); err != nil {
		t.Fatalf("Expected valid config to pass validation, got: %v", err)
	}

	// Invalid URL
	invalidURL := &SAPConfig{
		URL: "ftp://vhcalnplci",
	}
	if err := invalidURL.Validate(); err == nil {
		t.Errorf("Expected error for non-http/https URL")
	}

	// Invalid Client
	invalidClient := &SAPConfig{
		URL:    "https://vhcalnplci:44300",
		Client: "12",
	}
	if err := invalidClient.Validate(); err == nil {
		t.Errorf("Expected error for 2-digit client")
	}

	// Invalid AuthType
	invalidAuth := &SAPConfig{
		URL:      "https://vhcalnplci:44300",
		AuthType: "invalid-auth",
	}
	if err := invalidAuth.Validate(); err == nil {
		t.Errorf("Expected error for unsupported authType")
	}
}

func TestSAPConfig_ZeroPasswordLeakage(t *testing.T) {
	cfg := &SAPConfig{
		URL:      "https://vhcalnplci:44300",
		Client:   "100",
		Username: "DEVELOPER",
		Password: "SuperSecretPassword123!",
	}

	// 1. Check JSON serialization ignores Password
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	jsonStr := string(data)
	if jsonStr == "" || jsonStr == "{}" {
		t.Errorf("Unexpected empty JSON output")
	}

	if jsonStr != "" && (filepath.Base(jsonStr) != "" && contains(jsonStr, "SuperSecretPassword123!")) {
		t.Errorf("Security violation: Password found in JSON serialization: %s", jsonStr)
	}

	// 2. Check RedactedCopy removes password
	redacted := cfg.RedactedCopy()
	if redacted.Password != "" {
		t.Errorf("Expected empty password in redacted copy, got: %s", redacted.Password)
	}
	if cfg.Password != "SuperSecretPassword123!" {
		t.Errorf("Original password was mutated")
	}
}

func TestLocalFileSAPConfigStore_SaveAndLoad(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewLocalFileSAPConfigStore(tmpDir)

	if store.HasConfig() {
		t.Errorf("Expected store to not have config initially")
	}

	cfg := &SAPConfig{
		URL:        "https://vhcalnplci:44300",
		Client:     "100",
		AuthType:   "basic",
		Username:   "DEVELOPER",
		Password:   "MySecretPass",
		SystemType: "onprem",
	}

	if err := store.Save(cfg); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if !store.HasConfig() {
		t.Errorf("Expected store to have config after Save")
	}

	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if loaded.URL != cfg.URL {
		t.Errorf("Expected URL %s, got %s", cfg.URL, loaded.URL)
	}
	if loaded.Client != cfg.Client {
		t.Errorf("Expected Client %s, got %s", cfg.Client, loaded.Client)
	}
	if loaded.Username != cfg.Username {
		t.Errorf("Expected Username %s, got %s", cfg.Username, loaded.Username)
	}
	if loaded.Password != "" {
		t.Errorf("Security violation: loaded password should be empty from file, got: %s", loaded.Password)
	}

	if err := store.Clear(); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}
	if store.HasConfig() {
		t.Errorf("Expected config to be removed after Clear")
	}
}

func TestMemoryCredentialStore(t *testing.T) {
	cs := NewMemoryCredentialStore()
	target := "TrueAI_SAP_DEV"

	err := cs.SetCredential(target, "DEVELOPER", []byte("Secret123"))
	if err != nil {
		t.Fatalf("SetCredential failed: %v", err)
	}

	user, secret, err := cs.GetCredential(target)
	if err != nil {
		t.Fatalf("GetCredential failed: %v", err)
	}
	if user != "DEVELOPER" || string(secret) != "Secret123" {
		t.Errorf("Credential mismatch: got user %s, secret %s", user, string(secret))
	}

	if err := cs.DeleteCredential(target); err != nil {
		t.Fatalf("DeleteCredential failed: %v", err)
	}

	_, _, err = cs.GetCredential(target)
	if err != ErrCredentialNotFound {
		t.Errorf("Expected ErrCredentialNotFound, got %v", err)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) > 0 && indexOf(s, substr) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}


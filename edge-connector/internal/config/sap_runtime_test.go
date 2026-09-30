package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeEnvironmentIsTemporaryAndComplete(t *testing.T) {
	cfg := &SAPConfig{URL: "http://example.test:8000", Client: "210", Username: "USR1", AuthType: "basic", ConnectionType: "http", SystemType: "onprem"}
	path, err := CreateSAPRuntimeEnv(t.TempDir(), cfg, []byte("a=b#c"))
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"SAP_URL=", "SAP_CLIENT=", "SAP_AUTH_TYPE=basic", "SAP_CONNECTION_TYPE=http", "SAP_SYSTEM_TYPE=onprem", "SAP_USERNAME=", "SAP_PASSWORD="} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("missing %s", key)
		}
	}
	if cfg.Password != "" {
		t.Fatal("secret placed in serializable config")
	}
}

func TestStaleRuntimeSecretCleanup(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "sap-runtime-old.env")
	recent := filepath.Join(dir, "sap-runtime-current.env")
	for _, path := range []string{old, recent} {
		if err := os.WriteFile(path, []byte("secret"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	stamp := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(old, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	CleanupStaleSAPRuntimeEnv(dir)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("stale secret file remains: %v", err)
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatalf("recent launch file removed: %v", err)
	}
}

func TestSetupProfileRejectsUnsupportedOptions(t *testing.T) {
	c := &SAPConfig{URL: "http://example.test", Client: "210", Username: "U", AuthType: "basic", ConnectionType: "http", SystemType: "onprem"}
	if err := c.ValidateSetup(); err != nil {
		t.Fatal(err)
	}
	c.SystemType = "cloud"
	if err := c.ValidateSetup(); err == nil {
		t.Fatal("cloud setup accepted")
	}
	c.SystemType = "onprem"
	c.URL = "http://user:secret@example.test"
	if err := c.ValidateSetup(); err == nil {
		t.Fatal("URL credentials accepted")
	}
}

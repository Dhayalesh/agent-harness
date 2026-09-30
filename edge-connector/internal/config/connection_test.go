package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultServerURLAndLocalOverride(t *testing.T) {
	const production = "wss://edge-server-conector.duckdns.org/ws"
	if got := NewDefaultConfig().ServerURL; got != production {
		t.Fatalf("default Edge Server URL = %q, want %q", got, production)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	loaded, err := LoadConfig(path)
	if err != nil || loaded.ServerURL != production {
		t.Fatalf("missing config should use production WSS URL: %v, %v", loaded, err)
	}
	if err := os.WriteFile(path, []byte(`{"serverUrl":"ws://127.0.0.1:8080/ws"}`), 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadConfig(path)
	if err != nil || loaded.ServerURL != "ws://127.0.0.1:8080/ws" {
		t.Fatalf("local development config override failed: %v, %v", loaded, err)
	}
}

func TestConnectionIdentityPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"logLevel":"debug","destination":"DEV"}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := NewDefaultConfig()
	c.ServerURL = "ws://localhost:8080/ws"
	c.TenantID = "acme"
	c.UserEmail = "user@company.com"
	if err := c.EnsureDeviceID(); err != nil {
		t.Fatal(err)
	}
	first := c.DeviceID
	if len(first) != 37 || first[:5] != "edge-" {
		t.Fatalf("bad device ID: %q", first)
	}
	if err := c.EnsureDeviceID(); err != nil {
		t.Fatal(err)
	}
	if c.DeviceID != first {
		t.Fatal("device ID changed")
	}
	if err := c.SaveConnectionFields(path); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DeviceID != first || loaded.UserEmail != c.UserEmail || loaded.TenantID != c.TenantID || loaded.ServerURL != c.ServerURL {
		t.Fatalf("identity did not persist: %+v", loaded)
	}
	var fields map[string]interface{}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["logLevel"] != "debug" || fields["destination"] != "DEV" {
		t.Fatal("existing config lost")
	}
	other := NewDefaultConfig()
	if err := other.EnsureDeviceID(); err != nil {
		t.Fatal(err)
	}
	if other.DeviceID == first {
		t.Fatal("two generated IDs matched")
	}
}

func TestValidEmail(t *testing.T) {
	for _, v := range []string{"user@company.com", "first.last+tag@example.org"} {
		if !ValidEmail(v) {
			t.Errorf("rejected %q", v)
		}
	}
	for _, v := range []string{"", "a", "a@b", "Name <a@b.com>", "a@b.com\n", " a@b.com", "a@@b.com"} {
		if ValidEmail(v) {
			t.Errorf("accepted %q", v)
		}
	}
}

func TestServerURLRequiresTLSOffLoopback(t *testing.T) {
	c := NewDefaultConfig()
	c.ServerURL = "ws://edge.example.com/ws"
	if err := c.Validate(); err == nil {
		t.Fatal("remote plaintext WebSocket accepted")
	}
	c.ServerURL = "wss://edge.example.com/ws"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

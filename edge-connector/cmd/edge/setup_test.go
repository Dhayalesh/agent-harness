package main

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trueai/edge-connector/internal/config"
)

func TestIdentityAndSAPSetup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	c := config.NewDefaultConfig()
	var output bytes.Buffer
	in := bufio.NewReader(strings.NewReader("bad-email\nuser@company.com\n"))
	if err := setupIdentity(c, path, false, in, &output); err != nil {
		t.Fatal(err)
	}
	if c.DeviceID == "" || c.UserEmail != "user@company.com" {
		t.Fatal("identity was not configured")
	}
	id := c.DeviceID
	if err := setupIdentity(c, path, false, bufio.NewReader(strings.NewReader("")), &output); err != nil {
		t.Fatal(err)
	}
	if c.DeviceID != id {
		t.Fatal("device identity changed")
	}
	secret := "unique-setup-secret"
	creds := config.NewMemoryCredentialStore()
	in = bufio.NewReader(strings.NewReader("http://example.test:8000\n210\nUSR1\n" + secret + "\n\n"))
	sap, err := setupSAP(c, path, false, in, &output, creds)
	if err != nil {
		t.Fatal(err)
	}
	if sap.SystemType != "onprem" {
		t.Fatal("wrong system type")
	}
	for _, p := range []string{path, filepath.Join(dir, "sap_config.json")} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte(secret)) {
			t.Fatalf("password persisted in %s", p)
		}
	}
	if strings.Contains(output.String(), secret) {
		t.Fatal("password appeared in output")
	}
	_, stored, err := creds.GetCredential(config.CredentialTarget(path))
	if err != nil || string(stored) != secret {
		t.Fatal("CredentialStore was not used")
	}
	output.Reset()
	_, err = setupSAP(c, path, false, bufio.NewReader(strings.NewReader("")), &output, creds)
	if err != nil || !strings.Contains(output.String(), "SAP configuration loaded") {
		t.Fatal("subsequent startup did not load config")
	}
}

func TestChangeAccountKeepsDeviceID(t *testing.T) {
	c := config.NewDefaultConfig()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := setupIdentity(c, path, false, bufio.NewReader(strings.NewReader("old@example.com\n")), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	id := c.DeviceID
	if err := setupIdentity(c, path, true, bufio.NewReader(strings.NewReader("new@example.com\n")), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if c.DeviceID != id || c.UserEmail != "new@example.com" {
		t.Fatal("account change lost device identity")
	}
}

func TestIdentityAllowsServerWithoutTenant(t *testing.T) {
	c := config.NewDefaultConfig()
	c.ServerURL = "ws://127.0.0.1:8080/ws"
	c.UserEmail = "user@company.com"
	if err := setupIdentity(c, filepath.Join(t.TempDir(), "config.json"), false, bufio.NewReader(strings.NewReader("")), &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if c.TenantID != "" || c.DeviceID == "" {
		t.Fatalf("unexpected identity: %+v", c)
	}
}

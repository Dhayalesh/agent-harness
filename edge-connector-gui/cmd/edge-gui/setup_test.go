package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/trueai/edge-connector-gui/internal/config"
)

type memoryCredentials struct {
	user   string
	secret []byte
}

func (m *memoryCredentials) SetCredential(_ string, user string, secret []byte) error {
	m.user = user
	m.secret = append([]byte(nil), secret...)
	return nil
}

func (m *memoryCredentials) GetCredential(_ string) (string, []byte, error) {
	if len(m.secret) == 0 {
		return "", nil, errors.New("missing")
	}
	return m.user, append([]byte(nil), m.secret...), nil
}

func TestInteractiveSetupSavesIdentityAndSecretSeparately(t *testing.T) {
	root := t.TempDir()
	cfg, err := config.LoadForSetup(root)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	input := bufio.NewReader(strings.NewReader("bad\nuser@example.test\n"))
	if err := setupIdentity(&cfg, false, input, &output); err != nil {
		t.Fatal(err)
	}
	if cfg.Email != "user@example.test" {
		t.Fatal("email was not saved")
	}
	if _, err := config.Load(root); err != nil {
		t.Fatal(err)
	}
	store := &memoryCredentials{}
	input = bufio.NewReader(strings.NewReader("Test SAP Logon\nhttps://sap.example.test\n100\nTESTUSER\n\n"))
	system, err := setupSAP(root, false, input, &output, store, func(*bufio.Reader, io.Writer) (string, error) {
		return "example-secret", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if system.ConnectionName != "Test SAP Logon" || string(store.secret) != "example-secret" {
		t.Fatal("SAP setup did not retain system and credential")
	}
	file, err := os.ReadFile(config.SAPConfigPath(root))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(file, store.secret) || bytes.Contains(output.Bytes(), store.secret) {
		t.Fatal("SAP password appeared in file or setup output")
	}
	output.Reset()
	if _, err := setupSAP(root, false, bufio.NewReader(strings.NewReader("")), &output, store, nil); err != nil {
		t.Fatal("saved setup should not prompt:", err)
	}
}

package mcp

import (
	"errors"
	"strings"
	"testing"

	"github.com/trueai/edge-connector-gui/internal/config"
)

type testCredentialStore struct {
	user   string
	secret []byte
}

func (s testCredentialStore) SetCredential(string, string, []byte) error { return errors.New("unused") }
func (s testCredentialStore) GetCredential(string) (string, []byte, error) {
	return s.user, append([]byte(nil), s.secret...), nil
}

func TestDesktopEnvironmentUsesDedicatedSAPConfig(t *testing.T) {
	t.Setenv("SAP_CONFIG_FILE", "parent-file")
	t.Setenv(config.SAPPasswordEnv, "parent-secret")
	host := New(t.TempDir(), nil)
	host.ConfigureSAP("TESTUSER", testCredentialStore{user: "TESTUSER", secret: []byte("child-secret")})
	env, err := host.desktopEnv()
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "SAP_CONFIG_FILE="+config.SAPConfigPath(host.root)) ||
		!strings.Contains(joined, config.SAPPasswordEnv+"=child-secret") ||
		strings.Contains(joined, "parent-file") || strings.Contains(joined, "parent-secret") {
		t.Fatal("SAP child environment did not use dedicated config and credential")
	}
}

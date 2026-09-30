package tests

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	"github.com/trueai/edge-connector/internal/config"
	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/runtime"
)

func TestGeneratedSAPSetupStartsEmbeddedHost(t *testing.T) {
	if !runtime.HasEmbeddedHost() {
		t.Skip("embedded host unavailable")
	}
	exe, err := runtime.EnsureExtractedTo(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("unique-runtime-secret")
	sap := &config.SAPConfig{URL: "http://127.0.0.1:1", Client: "210", Username: "USR1", AuthType: "basic", ConnectionType: "http", SystemType: "onprem"}
	var logs bytes.Buffer
	m := &manifest.Manifest{ID: "sap-adt", Name: "SAP ADT", Version: "1.0.0", Transport: "stdio", Executable: exe, Destination: "DEV", SystemType: "onprem", Arguments: []string{"--transport=stdio"}, StartupTimeout: 30 * time.Second, RequestTimeout: 30 * time.Second, RestartPolicy: manifest.DefaultRestartPolicy()}
	inst := process.NewInstance(m, logging.NewLogger(&logs, "debug", true))
	stateDir := t.TempDir()
	var envPath string
	inst.SetLaunchEnvironment(func() (string, func(), error) {
		path, err := config.CreateSAPRuntimeEnv(stateDir, sap, secret)
		envPath = path
		return path, func() { _ = os.Remove(path) }, err
	})
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	if err := inst.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer inst.Stop(context.Background())
	if inst.ServerInfo().Name != "mcp-abap-adt" || len(inst.Tools()) != 206 {
		t.Fatalf("unexpected MCP discovery: %+v, %d tools", inst.ServerInfo(), len(inst.Tools()))
	}
	if _, err := os.Stat(envPath); !os.IsNotExist(err) {
		t.Fatalf("runtime secret file remains after handshake: %v", err)
	}
	if bytes.Contains(logs.Bytes(), secret) {
		t.Fatal("SAP password leaked to logs")
	}
}

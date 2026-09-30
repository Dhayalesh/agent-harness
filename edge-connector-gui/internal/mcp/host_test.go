package mcp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/trueai/edge-connector-gui/internal/config"
)

func TestRealUpstreamDesktopMCP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root := t.TempDir()
	if err := config.SaveSAP(root, config.SAPSystem{ConnectionName: "Test SAP Logon",
		Host: "https://sap.example.test", Client: "100", User: "TESTUSER", Language: "EN"}); err != nil {
		t.Fatal(err)
	}
	host := New(root, nil)
	host.ConfigureSAP("TESTUSER", testCredentialStore{user: "TESTUSER", secret: []byte("test-password")})
	defer host.Close()
	if err := host.Start(ctx); err != nil {
		t.Fatal(err)
	}
	upstreamPID := host.cmd.Process.Pid
	init, err := host.Handle(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":"remote","method":"initialize"}`))
	if err != nil {
		t.Fatal(err)
	}
	var initialized struct {
		ID     string `json:"id"`
		Result struct {
			ServerInfo json.RawMessage `json:"serverInfo"`
		} `json:"result"`
	}
	if json.Unmarshal(init, &initialized) != nil || initialized.ID != "remote" || len(initialized.Result.ServerInfo) == 0 {
		t.Fatalf("initialize did not return upstream result")
	}
	listed, err := host.Handle(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	if err != nil {
		t.Fatal(err)
	}
	var tools struct {
		Result struct {
			Tools []struct {
				Name        string          `json:"name"`
				Description string          `json:"description"`
				InputSchema json.RawMessage `json:"inputSchema"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(listed, &tools); err != nil {
		t.Fatal(err)
	}
	if len(tools.Result.Tools) == 0 {
		t.Fatal("no upstream tools discovered")
	}
	found := false
	for _, tool := range tools.Result.Tools {
		if tool.Name == "sap_list_connections" && len(tool.InputSchema) > 0 {
			found = true
		}
	}
	if !found {
		t.Fatal("upstream sap_list_connections missing")
	}
	called, err := host.Handle(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sap_list_connections","arguments":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Result struct {
			Content []json.RawMessage `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal(called, &result) != nil || len(result.Result.Content) == 0 {
		t.Fatal("upstream tool call returned no content")
	}
	if host.cmd.Process.Pid != upstreamPID {
		t.Fatal("upstream process restarted between MCP calls")
	}
}

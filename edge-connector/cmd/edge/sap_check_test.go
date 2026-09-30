package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/trueai/edge-connector/internal/mcp/protocol"
)

func TestVerifySAP(t *testing.T) {
	tools := []protocol.ToolDefinition{{Name: "GetPackage", Description: "Retrieve ABAP package metadata", InputSchema: json.RawMessage(`{"type":"object","required":["package_name"]}`)}}
	called := false
	call := func(_ context.Context, name string, args map[string]interface{}) (*protocol.ToolsCallResult, error) {
		called = true
		if name != "GetPackage" || args["package_name"] != "BASIS" {
			t.Fatal("unsafe validation call")
		}
		return &protocol.ToolsCallResult{Content: []protocol.ToolContent{{Type: "text", Text: "BASIS"}}}, nil
	}
	if err := verifySAP(context.Background(), tools, call); err != nil || !called {
		t.Fatalf("valid ADT call rejected: %v", err)
	}
	if err := verifySAP(context.Background(), tools, func(context.Context, string, map[string]interface{}) (*protocol.ToolsCallResult, error) {
		return &protocol.ToolsCallResult{IsError: true}, nil
	}); err == nil {
		t.Fatal("MCP tool error accepted")
	}
	if err := verifySAP(context.Background(), tools, func(context.Context, string, map[string]interface{}) (*protocol.ToolsCallResult, error) {
		return nil, errors.New("secret-value")
	}); err == nil || err.Error() == "secret-value" {
		t.Fatal("raw failure leaked or accepted")
	}
	tools[0].InputSchema = json.RawMessage(`{"required":["package_name","write"]}`)
	if err := verifySAP(context.Background(), tools, call); err == nil {
		t.Fatal("changed schema accepted")
	}
}

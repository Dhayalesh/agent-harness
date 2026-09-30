package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/trueai/edge-connector/internal/mcp/protocol"
)

// verifySAP requires the expected read-only schema and a successful live ADT
// tool response. The BASIS package is a standard SAP repository package.

type sapToolCaller func(context.Context, string, map[string]interface{}) (*protocol.ToolsCallResult, error)

func verifySAP(ctx context.Context, tools []protocol.ToolDefinition, call sapToolCaller) error {
	var tool protocol.ToolDefinition
	ok := false
	for _, candidate := range tools {
		if candidate.Name == "GetPackage" {
			tool, ok = candidate, true
			break
		}
	}
	if !ok || !strings.Contains(strings.ToLower(tool.Description), "package") {
		return errors.New("read-only ADT validation tool unavailable")
	}
	var schema struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
		return errors.New("ADT validation tool schema unavailable")
	}
	if len(schema.Required) != 1 || schema.Required[0] != "package_name" {
		return errors.New("ADT validation tool schema changed")
	}
	if call == nil {
		return errors.New("MCP process is unavailable")
	}
	result, err := call(ctx, "GetPackage", map[string]interface{}{"package_name": "BASIS"})
	if err != nil {
		return sapFailureReason(err.Error())
	}
	if result == nil {
		return errors.New("SAP ADT endpoint returned an error")
	}
	if result.IsError {
		var summary strings.Builder
		for _, item := range result.Content {
			summary.WriteString(item.Text)
		}
		return sapFailureReason(summary.String())
	}
	if len(result.Content) == 0 {
		return errors.New("SAP ADT endpoint returned an empty result")
	}
	for _, item := range result.Content {
		message := strings.ToLower(strings.TrimSpace(item.Text))
		if strings.HasPrefix(message, "error:") || strings.HasPrefix(message, "failed to ") {
			return sapFailureReason(item.Text)
		}
	}
	return nil
}

func sapFailureReason(raw string) error {
	text := strings.ToLower(raw)
	switch {
	case strings.Contains(text, "401"), strings.Contains(text, "403"), strings.Contains(text, "unauthorized"), strings.Contains(text, "authentication failed"), strings.Contains(text, "invalid credentials"):
		return errors.New("Authentication failed")
	case strings.Contains(text, "econnrefused"), strings.Contains(text, "enotfound"), strings.Contains(text, "timeout"), strings.Contains(text, "timed out"), strings.Contains(text, "no such host"), strings.Contains(text, "fetch failed"):
		return errors.New("Unable to reach the configured SAP system")
	default:
		return errors.New("ADT endpoint returned an error")
	}
}

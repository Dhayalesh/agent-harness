package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestStructuredLogging(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := NewLogger(buf, "debug", true)

	compLogger := WithComponent(logger, ComponentProcess)
	mcpLogger := WithMCP(compLogger, "sap-adt")
	reqLogger := WithRequest(mcpLogger, "sap-adt", "req-12345")

	LogEvent(context.Background(), reqLogger, slog.LevelInfo, EventStart, "Process started successfully", "pid", 1234)

	var entry map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("Failed to parse log JSON: %v, raw output: %s", err, buf.String())
	}

	if entry["component"] != ComponentProcess {
		t.Errorf("Expected component %s, got %v", ComponentProcess, entry["component"])
	}
	if entry["mcpId"] != "sap-adt" {
		t.Errorf("Expected mcpId 'sap-adt', got %v", entry["mcpId"])
	}
	if entry["requestId"] != "req-12345" {
		t.Errorf("Expected requestId 'req-12345', got %v", entry["requestId"])
	}
	if entry["event"] != EventStart {
		t.Errorf("Expected event %s, got %v", EventStart, entry["event"])
	}
}

func TestSecretSanitization(t *testing.T) {
	buf := &bytes.Buffer{}
	logger := NewLogger(buf, "info", true)

	logger.Info("Attempting authentication",
		"service_key", "{\"client\":\"100\",\"secret\":\"TOPSECRET\"}",
		"password", "very_secret_pass",
		"user", "normal_user",
	)

	var entry map[string]interface{}
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("Failed to parse log JSON: %v", err)
	}

	if entry["service_key"] != "[REDACTED]" {
		t.Errorf("Expected service_key to be [REDACTED], got %v", entry["service_key"])
	}
	if entry["password"] != "[REDACTED]" {
		t.Errorf("Expected password to be [REDACTED], got %v", entry["password"])
	}
	if entry["user"] != "normal_user" {
		t.Errorf("Expected user to be 'normal_user', got %v", entry["user"])
	}

	// Verify substring check in raw buffer
	if strings.Contains(buf.String(), "TOPSECRET") || strings.Contains(buf.String(), "very_secret_pass") {
		t.Errorf("Found raw secret in log output: %s", buf.String())
	}
}


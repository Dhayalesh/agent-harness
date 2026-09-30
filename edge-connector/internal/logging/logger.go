package logging

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// Component names for structured logging
const (
	ComponentConfig   = "config"
	ComponentHealth   = "health"
	ComponentProcess  = "process"
	ComponentProtocol = "protocol"
	ComponentRegistry = "registry"
	ComponentRouter   = "router"
	ComponentPolicy   = "policy"
	ComponentMain     = "main"
)

// Common event names for structured logging
const (
	EventStart        = "process_start"
	EventStop         = "process_stop"
	EventExit         = "process_exit"
	EventRestart      = "process_restart"
	EventCrash        = "process_crash"
	EventBackoff      = "restart_backoff"
	EventLoopDetected = "restart_loop_detected"
	EventInit         = "mcp_initialize"
	EventToolsList    = "mcp_tools_list"
	EventToolCall     = "mcp_tool_call"
	EventPolicyReject = "policy_rejection"
	EventHealthCheck  = "health_check"
	EventShutdown     = "edge_shutdown"
)

var sensitiveKeys = []string{
	"password", "secret", "token", "apikey", "api_key",
	"authorization", "private_key", "service_key", "credentials",
}

// sanitizeAttribute sanitizes any attribute keys or values that might contain secrets.
func sanitizeAttribute(groups []string, a slog.Attr) slog.Attr {
	keyLower := strings.ToLower(a.Key)
	for _, secret := range sensitiveKeys {
		if strings.Contains(keyLower, secret) {
			return slog.Attr{
				Key:   a.Key,
				Value: slog.StringValue("[REDACTED]"),
			}
		}
	}
	// Also sanitize string values if they contain embedded JSON or key-value secrets
	if a.Value.Kind() == slog.KindString {
		strVal := a.Value.String()
		strValLower := strings.ToLower(strVal)
		for _, secret := range sensitiveKeys {
			if strings.Contains(strValLower, secret) && (strings.Contains(strVal, ":") || strings.Contains(strVal, "=")) {
				return slog.Attr{
					Key:   a.Key,
					Value: slog.StringValue("[REDACTED]"),
				}
			}
		}
	}
	return a
}

// NewLogger creates a new structured slog.Logger with the specified level and output writer.
func NewLogger(w io.Writer, levelStr string, jsonFormat bool) *slog.Logger {
	if w == nil {
		w = os.Stdout
	}

	var level slog.Level
	switch strings.ToLower(levelStr) {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: sanitizeAttribute,
	}

	var handler slog.Handler
	if jsonFormat {
		handler = slog.NewJSONHandler(w, opts)
	} else {
		handler = slog.NewTextHandler(w, opts)
	}

	return slog.New(handler)
}

// WithComponent returns a sub-logger enriched with the component attribute.
func WithComponent(logger *slog.Logger, component string) *slog.Logger {
	if logger == nil {
		return slog.Default().With("component", component)
	}
	return logger.With("component", component)
}

// WithMCP returns a sub-logger enriched with mcpId.
func WithMCP(logger *slog.Logger, mcpID string) *slog.Logger {
	if logger == nil {
		return slog.Default().With("mcpId", mcpID)
	}
	return logger.With("mcpId", mcpID)
}

// WithRequest returns a sub-logger enriched with requestId and mcpId.
func WithRequest(logger *slog.Logger, mcpID string, requestID string) *slog.Logger {
	l := logger
	if l == nil {
		l = slog.Default()
	}
	attrs := make([]any, 0, 4)
	if mcpID != "" {
		attrs = append(attrs, "mcpId", mcpID)
	}
	if requestID != "" {
		attrs = append(attrs, "requestId", requestID)
	}
	return l.With(attrs...)
}

// LogEvent logs a structured event.
func LogEvent(ctx context.Context, logger *slog.Logger, level slog.Level, event string, msg string, attrs ...any) {
	if logger == nil {
		logger = slog.Default()
	}
	allAttrs := make([]any, 0, len(attrs)+2)
	allAttrs = append(allAttrs, slog.String("event", event))
	allAttrs = append(allAttrs, attrs...)
	logger.Log(ctx, level, msg, allAttrs...)
}


package policy

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/trueai/edge-connector/internal/logging"
)

var (
	ErrMCPNotAllowed       = errors.New("mcp not permitted by policy")
	ErrToolNotAllowed      = errors.New("tool not permitted by policy")
	ErrResponseTooLarge    = errors.New("tool response exceeds maximum allowed size")
	ErrDisallowedParameter = errors.New("request contains disallowed execution parameters")
)

// DisallowedParamKeys that should NEVER be accepted from a caller
var DisallowedParamKeys = []string{
	"executable", "exec", "cmd", "command", "shell", "powershell", "bash", "python", "script",
	"destination", "mcp_destination", "sap_destination",
	"env", "environment", "env_path", "envpath", "env_file", "envfile",
	"system_type", "systemtype",
	"cwd", "working_dir", "working_directory",
	"service_key", "servicekey", "credentials", "auth",
}

// Engine implements policy evaluation for True.ai Edge.
type Engine struct {
	mu                   sync.RWMutex
	allowedMCPs          map[string]bool
	allowedTools         map[string]map[string]bool // mcpID -> toolName -> bool
	maxResponseSizeBytes int64
	defaultTimeout       time.Duration
	logger               *slog.Logger
}

// Config provides initial policy parameters.
type Config struct {
	AllowedMCPs          []string
	AllowedTools         map[string][]string
	MaxResponseSizeBytes int64
	DefaultTimeout       time.Duration
}

// NewEngine creates a new policy evaluation engine.
func NewEngine(cfg Config, logger *slog.Logger) *Engine {
	if logger == nil {
		logger = slog.Default()
	}

	allowedMCPs := make(map[string]bool)
	if len(cfg.AllowedMCPs) == 0 {
		// Default initial allowed MCP
		allowedMCPs["sap-adt"] = true
	} else {
		for _, id := range cfg.AllowedMCPs {
			allowedMCPs[id] = true
		}
	}

	allowedTools := make(map[string]map[string]bool)
	for mcpID, tools := range cfg.AllowedTools {
		toolMap := make(map[string]bool)
		for _, tool := range tools {
			toolMap[tool] = true
		}
		allowedTools[mcpID] = toolMap
	}

	maxSize := cfg.MaxResponseSizeBytes
	if maxSize <= 0 {
		maxSize = 10 * 1024 * 1024 // 10 MB
	}

	timeout := cfg.DefaultTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	return &Engine{
		allowedMCPs:          allowedMCPs,
		allowedTools:         allowedTools,
		maxResponseSizeBytes: maxSize,
		defaultTimeout:       timeout,
		logger:               logging.WithComponent(logger, logging.ComponentPolicy),
	}
}

// AllowMCP dynamically permits an MCP ID.
func (e *Engine) AllowMCP(mcpID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.allowedMCPs[mcpID] = true
}

// ValidateMCP checks whether the specified MCP is permitted.
func (e *Engine) ValidateMCP(mcpID string) error {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if !e.allowedMCPs[mcpID] {
		e.logger.Warn("Policy violation: MCP ID is not permitted", "mcpId", mcpID)
		return fmt.Errorf("%w: '%s'", ErrMCPNotAllowed, mcpID)
	}
	return nil
}

// ValidateTool checks whether the tool is permitted for the given MCP.
func (e *Engine) ValidateTool(mcpID string, toolName string, discoveredTools []string) error {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if toolName == "" {
		return fmt.Errorf("%w: tool name cannot be empty", ErrToolNotAllowed)
	}

	// 1. Check if tool was discovered from MCP
	toolDiscovered := false
	for _, dt := range discoveredTools {
		if dt == toolName {
			toolDiscovered = true
			break
		}
	}
	if !toolDiscovered {
		e.logger.Warn("Policy violation: tool not exposed by MCP", "mcpId", mcpID, "tool", toolName)
		return fmt.Errorf("%w: tool '%s' is not exposed by mcp '%s'", ErrToolNotAllowed, toolName, mcpID)
	}

	// 2. Check whitelist if defined for this MCP
	whitelist, hasWhitelist := e.allowedTools[mcpID]
	if hasWhitelist && len(whitelist) > 0 {
		if !whitelist["*"] && !whitelist[toolName] {
			e.logger.Warn("Policy violation: tool not in allowed whitelist", "mcpId", mcpID, "tool", toolName)
			return fmt.Errorf("%w: tool '%s' is not in allowed whitelist for mcp '%s'", ErrToolNotAllowed, toolName, mcpID)
		}
	}

	return nil
}

// ValidateArguments verifies that the caller is not trying to inject arbitrary commands or processes.
func (e *Engine) ValidateArguments(args map[string]interface{}) error {
	for k := range args {
		kLower := strings.ToLower(k)
		for _, forbidden := range DisallowedParamKeys {
			if kLower == forbidden {
				e.logger.Error("Security policy violation: caller attempted to specify forbidden execution parameter", "param", k)
				return fmt.Errorf("%w: '%s' is strictly forbidden", ErrDisallowedParameter, k)
			}
		}
	}
	return nil
}

// ValidateResponseSize checks if response payload exceeds max response size.
func (e *Engine) ValidateResponseSize(sizeBytes int64) error {
	if sizeBytes > e.maxResponseSizeBytes {
		e.logger.Warn("Response size limit exceeded", "sizeBytes", sizeBytes, "limit", e.maxResponseSizeBytes)
		return fmt.Errorf("%w: received %d bytes, limit is %d bytes", ErrResponseTooLarge, sizeBytes, e.maxResponseSizeBytes)
	}
	return nil
}

// MaxResponseSize returns the configured maximum response size limit in bytes.
func (e *Engine) MaxResponseSize() int64 {
	return e.maxResponseSizeBytes
}

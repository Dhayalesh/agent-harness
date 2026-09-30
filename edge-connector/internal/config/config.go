package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Default constants for Edge Connector
const (
	DefaultServerURL            = "wss://edge-server-conector.duckdns.org/ws"
	DefaultShutdownTimeout      = 15 * time.Second
	DefaultRequestTimeout       = 30 * time.Second
	DefaultMaxResponseSizeBytes = 10 * 1024 * 1024 // 10 MB
	DefaultLogLevel             = "info"
	DefaultLogJSON              = true
	DefaultDestination          = "DEV"
)

// Config holds the runtime configuration for True.ai Edge.
type Config struct {
	ServerURL string `json:"serverUrl,omitempty"`
	TenantID  string `json:"tenantId,omitempty"`
	UserEmail string `json:"userEmail,omitempty"`
	DeviceID  string `json:"deviceId,omitempty"`
	// ManifestDir specifies where MCP manifest files (.yaml or .json) are located.
	ManifestDir string `json:"manifestDir"`

	// StateDir specifies where Edge stores local non-admin runtime state.
	StateDir string `json:"stateDir"`

	// LogDir specifies where Edge writes log files.
	LogDir string `json:"logDir"`

	// LogLevel sets the log filtering level (debug, info, warn, error).
	LogLevel string `json:"logLevel"`

	// LogJSON specifies whether to output logs in structured JSON format.
	LogJSON bool `json:"logJSON"`

	// Destination specifies the default SAP ADT destination (e.g. DEV, PROD).
	Destination string `json:"destination,omitempty"`

	// SAPExecutable specifies an optional explicit path or name for the ADT MCP binary.
	SAPExecutable string `json:"sapExecutable,omitempty"`

	// SAPEnvPath specifies an optional path to the SAP environment file (passed via --env-path).
	SAPEnvPath string `json:"sapEnvPath,omitempty"`

	// SAPSystemType specifies an optional SAP system type (passed via --system-type, e.g. onprem).
	SAPSystemType string `json:"sapSystemType,omitempty"`

	// ShutdownTimeout sets the maximum time to wait for active requests and processes to terminate.
	ShutdownTimeout time.Duration `json:"shutdownTimeout"`

	// DefaultRequestTimeout sets the default timeout for tool calls if not overridden by manifest.
	DefaultRequestTimeout time.Duration `json:"defaultRequestTimeout"`

	// MaxResponseSizeBytes limits the maximum memory buffer for a tool response.
	MaxResponseSizeBytes int64 `json:"maxResponseSizeBytes"`
}

// GetDefaultBaseDir resolves %LOCALAPPDATA%\TrueAI\Edge on Windows, or user config dir on other OS.
func GetDefaultBaseDir() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData != "" {
		return filepath.Join(localAppData, "TrueAI", "Edge")
	}

	userConfig, err := os.UserConfigDir()
	if err == nil && userConfig != "" {
		return filepath.Join(userConfig, "TrueAI", "Edge")
	}

	// Fallback to home dir
	homeDir, err := os.UserHomeDir()
	if err == nil && homeDir != "" {
		return filepath.Join(homeDir, ".trueai", "edge")
	}

	// Last resort fallback
	return filepath.Join(".", ".trueai-edge")
}

// NewDefaultConfig returns a default Config configured for the current non-admin Windows user.
func NewDefaultConfig() *Config {
	baseDir := GetDefaultBaseDir()

	return &Config{
		ServerURL:             DefaultServerURL,
		ManifestDir:           "", // Empty by default; Edge operates in Customer Mode using embedded manifest
		StateDir:              filepath.Join(baseDir, "state"),
		LogDir:                filepath.Join(baseDir, "logs"),
		LogLevel:              DefaultLogLevel,
		LogJSON:               DefaultLogJSON,
		Destination:           DefaultDestination,
		ShutdownTimeout:       DefaultShutdownTimeout,
		DefaultRequestTimeout: DefaultRequestTimeout,
		MaxResponseSizeBytes:  DefaultMaxResponseSizeBytes,
	}
}

// LoadConfig loads configuration from an optional file path, merging with defaults and env vars.
func LoadConfig(configPath string) (*Config, error) {
	cfg := NewDefaultConfig()
	if configPath == "" {
		configPath = filepath.Join(GetDefaultBaseDir(), "config.json")
	}

	if configPath != "" {
		if _, err := os.Stat(configPath); err == nil {
			data, err := os.ReadFile(configPath)
			if err != nil {
				return nil, fmt.Errorf("failed to read config file %s: %w", configPath, err)
			}
			if err := json.Unmarshal(data, cfg); err != nil {
				return nil, fmt.Errorf("failed to parse config file %s: %w", configPath, err)
			}
		} else if !os.IsNotExist(err) {
			return nil, fmt.Errorf("error accessing config file %s: %w", configPath, err)
		}
	}

	// Environment variable overrides
	if envManifest := os.Getenv("TRUEAI_MANIFEST_DIR"); envManifest != "" {
		cfg.ManifestDir = envManifest
	}
	if envState := os.Getenv("TRUEAI_STATE_DIR"); envState != "" {
		cfg.StateDir = envState
	}
	if envLog := os.Getenv("TRUEAI_LOG_DIR"); envLog != "" {
		cfg.LogDir = envLog
	}
	if envLogLevel := os.Getenv("TRUEAI_LOG_LEVEL"); envLogLevel != "" {
		cfg.LogLevel = envLogLevel
	}
	if envDest := os.Getenv("TRUEAI_SAP_DESTINATION"); envDest != "" {
		cfg.Destination = envDest
	}
	if envExec := os.Getenv("TRUEAI_SAP_EXECUTABLE"); envExec != "" {
		cfg.SAPExecutable = envExec
	}
	if envEnvPath := os.Getenv("TRUEAI_SAP_ENV_PATH"); envEnvPath != "" {
		cfg.SAPEnvPath = envEnvPath
	}
	if envSysType := os.Getenv("TRUEAI_SAP_SYSTEM_TYPE"); envSysType != "" {
		cfg.SAPSystemType = envSysType
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("configuration validation failed: %w", err)
	}

	return cfg, nil
}

// forbiddenSystemPrefixes on Windows to enforce non-admin security boundaries
var forbiddenSystemPrefixes = []string{
	`C:\Windows`,
	`C:\Program Files`,
	`C:\Program Files (x86)`,
	`C:\ProgramData`,
}

// Validate validates that the configuration meets non-admin, path safety, and operational constraints.
func (c *Config) Validate() error {
	if c.ServerURL != "" {
		u, err := url.Parse(c.ServerURL)
		if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" || u.User != nil || u.Fragment != "" {
			return fmt.Errorf("invalid Edge server URL: expected ws:// or wss:// host without credentials or fragment")
		}
		if u.Scheme == "ws" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
			return fmt.Errorf("unencrypted WebSocket is permitted only on localhost")
		}
	}
	if c.TenantID != "" {
		for _, ch := range c.TenantID {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.') {
				return fmt.Errorf("invalid tenant ID")
			}
		}
	}
	if c.UserEmail != "" && !ValidEmail(c.UserEmail) {
		return fmt.Errorf("invalid registered email")
	}
	if c.DeviceID != "" && (!strings.HasPrefix(c.DeviceID, "edge-") || len(c.DeviceID) != 37) {
		return fmt.Errorf("invalid device ID")
	}
	if c.StateDir == "" {
		return fmt.Errorf("stateDir must not be empty")
	}
	if c.LogDir == "" {
		return fmt.Errorf("logDir must not be empty")
	}
	if c.ShutdownTimeout <= 0 {
		c.ShutdownTimeout = DefaultShutdownTimeout
	}
	if c.DefaultRequestTimeout <= 0 {
		c.DefaultRequestTimeout = DefaultRequestTimeout
	}
	if c.MaxResponseSizeBytes <= 0 {
		c.MaxResponseSizeBytes = DefaultMaxResponseSizeBytes
	}

	// Validate Destination safety if provided
	if c.Destination != "" {
		for _, ch := range c.Destination {
			if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' || ch == '.') {
				return fmt.Errorf("security violation: destination name '%s' contains invalid characters", c.Destination)
			}
		}
	}

	// Verify that state and log directories do NOT target privileged system directories
	for _, dir := range []string{c.StateDir, c.LogDir} {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			return fmt.Errorf("invalid path for directory %s: %w", dir, err)
		}

		for _, prefix := range forbiddenSystemPrefixes {
			if strings.HasPrefix(strings.ToLower(absDir), strings.ToLower(prefix)) {
				return fmt.Errorf("security violation: directory %s resides in privileged path %s. Edge must run in user space", absDir, prefix)
			}
		}
	}

	return nil
}

// ValidEmail accepts a single mailbox address without a display name.
func ValidEmail(value string) bool {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	a, err := mail.ParseAddress(value)
	return err == nil && a.Address == value && strings.Count(value, "@") == 1 && strings.Contains(strings.SplitN(value, "@", 2)[1], ".")
}

// EnsureDeviceID creates a random, opaque device identifier once.
func (c *Config) EnsureDeviceID() error {
	if c.DeviceID != "" {
		return nil
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return err
	}
	c.DeviceID = "edge-" + hex.EncodeToString(b[:])
	return nil
}

// SaveConnectionFields merges connection identity into the existing config JSON.
// Existing MCP configuration is preserved and no SAP credentials are written.
func (c *Config) SaveConnectionFields(path string) error {
	if path == "" {
		path = filepath.Join(GetDefaultBaseDir(), "config.json")
	}
	if err := c.Validate(); err != nil {
		return err
	}
	fields := map[string]interface{}{}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &fields); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	fields["serverUrl"] = c.ServerURL
	fields["tenantId"] = c.TenantID
	fields["userEmail"] = c.UserEmail
	fields["deviceId"] = c.DeviceID
	data, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "config-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// EnsureDirectories creates required user directories (state and logs) if they do not exist.
func (c *Config) EnsureDirectories() error {
	for _, dir := range []string{c.StateDir, c.LogDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return fmt.Errorf("failed to initialize user directory %s: %w", dir, err)
		}
	}
	return nil
}

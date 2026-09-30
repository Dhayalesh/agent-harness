package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	ErrConfigNotFound     = errors.New("SAP configuration not found")
	ErrCredentialNotFound = errors.New("credential not found")
	ErrInvalidConfig      = errors.New("invalid SAP configuration")
)

// SAPConfig defines customer-configurable SAP connection settings.
// Password and secrets are explicitly excluded from JSON serialization
// to ensure zero credentials leak into disk config dumps, logs, or error messages.
type SAPConfig struct {
	URL            string `json:"url,omitempty"`
	Client         string `json:"client,omitempty"`
	AuthType       string `json:"authType,omitempty"` // "basic", "jwt", "x509"
	Username       string `json:"username,omitempty"`
	Password       string `json:"-"` // Never serialized to JSON
	Language       string `json:"language,omitempty"`
	SystemType     string `json:"systemType,omitempty"`     // "onprem", "cloud"
	ConnectionType string `json:"connectionType,omitempty"` // "direct", "rfc", "http"
}

// RedactedCopy returns a copy of SAPConfig guaranteed to contain no secrets.
func (c *SAPConfig) RedactedCopy() *SAPConfig {
	if c == nil {
		return nil
	}
	copy := *c
	copy.Password = ""
	return &copy
}

// Validate checks that required fields are syntactically valid.
func (c *SAPConfig) Validate() error {
	if c.URL == "" {
		return fmt.Errorf("%w: SAP URL must not be empty", ErrInvalidConfig)
	}

	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return fmt.Errorf("%w: SAP URL must be a valid http or https URL", ErrInvalidConfig)
	}

	if c.Client != "" {
		if len(c.Client) != 3 {
			return fmt.Errorf("%w: SAP Client must be a 3-digit number (e.g. 100)", ErrInvalidConfig)
		}
		for _, ch := range c.Client {
			if ch < '0' || ch > '9' {
				return fmt.Errorf("%w: SAP Client must be numeric", ErrInvalidConfig)
			}
		}
	}

	if c.AuthType != "" {
		authLower := strings.ToLower(c.AuthType)
		if authLower != "basic" && authLower != "jwt" && authLower != "x509" {
			return fmt.Errorf("%w: unsupported authType '%s' (must be basic, jwt, or x509)", ErrInvalidConfig, c.AuthType)
		}
	}

	if c.SystemType != "" {
		sysLower := strings.ToLower(c.SystemType)
		if sysLower != "onprem" && sysLower != "cloud" {
			return fmt.Errorf("%w: unsupported systemType '%s' (must be onprem or cloud)", ErrInvalidConfig, c.SystemType)
		}
	}

	return nil
}

// ValidateSetup applies the supported customer setup profile after basic validation.
func (c *SAPConfig) ValidateSetup() error {
	if err := c.Validate(); err != nil {
		return err
	}
	if c.Client == "" || strings.TrimSpace(c.Username) == "" || strings.ContainsAny(c.Username, "\r\n") {
		return fmt.Errorf("%w: SAP client and username are required", ErrInvalidConfig)
	}
	if c.AuthType != "basic" || c.ConnectionType != "http" || c.SystemType != "onprem" {
		return fmt.Errorf("%w: only basic/http/onprem is supported", ErrInvalidConfig)
	}
	return nil
}

// SAPConfigStore defines the contract for persisting and retrieving local customer SAP settings.
type SAPConfigStore interface {
	Load() (*SAPConfig, error)
	Save(cfg *SAPConfig) error
	HasConfig() bool
	Clear() error
}

// LocalFileSAPConfigStore stores customer configuration in %LOCALAPPDATA%\TrueAI\Edge\sap_config.json.
// Secrets are not stored in this file.
type LocalFileSAPConfigStore struct {
	filePath string
	mu       sync.RWMutex
}

// NewLocalFileSAPConfigStore creates a store saving config in the given directory or %LOCALAPPDATA%\TrueAI\Edge.
func NewLocalFileSAPConfigStore(baseDir string) *LocalFileSAPConfigStore {
	if baseDir == "" {
		baseDir = GetDefaultBaseDir()
	}
	return &LocalFileSAPConfigStore{
		filePath: filepath.Join(baseDir, "sap_config.json"),
	}
}

// HasConfig returns true if a saved configuration file exists.
func (s *LocalFileSAPConfigStore) HasConfig() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, err := os.Stat(s.filePath)
	return err == nil
}

// Load reads and unmarshals the customer SAP configuration.
func (s *LocalFileSAPConfigStore) Load() (*SAPConfig, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrConfigNotFound
		}
		return nil, fmt.Errorf("failed to read SAP config from %s: %w", s.filePath, err)
	}

	var cfg SAPConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse SAP config: %w", err)
	}

	return &cfg, nil
}

// Save writes the customer SAP configuration atomically with 0600 permissions.
func (s *LocalFileSAPConfigStore) Save(cfg *SAPConfig) error {
	if cfg == nil {
		return fmt.Errorf("cannot save nil SAPConfig")
	}

	if err := cfg.Validate(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create config directory %s: %w", dir, err)
	}

	// Always write redacted copy to disk; password is never saved in sap_config.json
	data, err := json.MarshalIndent(cfg.RedactedCopy(), "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize SAP config: %w", err)
	}

	tmpFile := fmt.Sprintf("%s.tmp.%d", s.filePath, os.Getpid())
	if err := os.WriteFile(tmpFile, data, 0600); err != nil {
		return fmt.Errorf("failed to write temporary config file: %w", err)
	}

	if err := os.Rename(tmpFile, s.filePath); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("failed to commit SAP config: %w", err)
	}

	return nil
}

// Clear removes the local configuration file.
func (s *LocalFileSAPConfigStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to clear SAP config: %w", err)
	}
	return nil
}

// CredentialStore defines the interface for secure password/token storage.
// Implementation point: On Windows production builds, this interface is backed by
// Windows Credential Manager (CredWriteW / CredReadW) or DPAPI (CryptProtectData).
type CredentialStore interface {
	SetCredential(target string, username string, secret []byte) error
	GetCredential(target string) (username string, secret []byte, err error)
	DeleteCredential(target string) error
}

// MemoryCredentialStore provides an in-memory/testing implementation of CredentialStore.
type MemoryCredentialStore struct {
	mu          sync.RWMutex
	credentials map[string]struct {
		username string
		secret   []byte
	}
}

// NewMemoryCredentialStore creates a memory-backed CredentialStore for testing.
func NewMemoryCredentialStore() *MemoryCredentialStore {
	return &MemoryCredentialStore{
		credentials: make(map[string]struct {
			username string
			secret   []byte
		}),
	}
}

func (m *MemoryCredentialStore) SetCredential(target string, username string, secret []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	secretCopy := make([]byte, len(secret))
	copy(secretCopy, secret)
	m.credentials[target] = struct {
		username string
		secret   []byte
	}{username: username, secret: secretCopy}
	return nil
}

func (m *MemoryCredentialStore) GetCredential(target string) (string, []byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cred, ok := m.credentials[target]
	if !ok {
		return "", nil, ErrCredentialNotFound
	}
	secretCopy := make([]byte, len(cred.secret))
	copy(secretCopy, cred.secret)
	return cred.username, secretCopy, nil
}

func (m *MemoryCredentialStore) DeleteCredential(target string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.credentials, target)
	return nil
}

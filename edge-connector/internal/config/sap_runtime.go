package config

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CredentialTarget scopes the vault entry to the configuration file.
func CredentialTarget(configPath string) string {
	if configPath == "" {
		configPath = filepath.Join(GetDefaultBaseDir(), "config.json")
	}
	path, err := filepath.Abs(configPath)
	if err == nil {
		configPath = path
	}
	sum := sha256.Sum256([]byte(strings.ToLower(configPath)))
	return fmt.Sprintf("TrueAI/Edge/SAP/%x", sum[:12])
}

// CleanupStaleSAPRuntimeEnv removes abandoned launch files from previous
// processes. Active launches finish within the one-minute grace period.
func CleanupStaleSAPRuntimeEnv(stateDir string) {
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Minute)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "sap-runtime-") || !strings.HasSuffix(entry.Name(), ".env") {
			continue
		}
		info, err := entry.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(stateDir, entry.Name()))
		}
	}
}

// CreateSAPRuntimeEnv creates a short-lived env file for the embedded host's
// --env-path contract. The caller removes it immediately after MCP startup.
func CreateSAPRuntimeEnv(stateDir string, cfg *SAPConfig, secret []byte) (string, error) {
	if cfg == nil || cfg.ValidateSetup() != nil || len(secret) == 0 {
		return "", fmt.Errorf("SAP setup is incomplete")
	}
	for _, v := range []string{cfg.URL, cfg.Client, cfg.Username, string(secret)} {
		if strings.ContainsAny(v, "\r\n\x00") {
			return "", fmt.Errorf("SAP configuration contains an unsupported control character")
		}
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return "", fmt.Errorf("runtime directory unavailable")
	}
	f, err := os.CreateTemp(stateDir, "sap-runtime-*.env")
	if err != nil {
		return "", fmt.Errorf("cannot create SAP runtime configuration")
	}
	defer f.Close()
	defer func() {
		if err != nil {
			_ = os.Remove(f.Name())
		}
	}()
	if err = f.Chmod(0600); err != nil {
		return "", fmt.Errorf("cannot protect SAP runtime configuration")
	}
	// Quoted dotenv values preserve spaces, # and = in passwords.
	_, err = fmt.Fprintf(f, "SAP_URL=%q\nSAP_CLIENT=%q\nSAP_AUTH_TYPE=basic\nSAP_CONNECTION_TYPE=http\nSAP_SYSTEM_TYPE=onprem\nSAP_USERNAME=%q\nSAP_PASSWORD=%q\n", cfg.URL, cfg.Client, cfg.Username, string(secret))
	if err != nil {
		return "", fmt.Errorf("cannot write SAP runtime configuration")
	}
	if err = f.Sync(); err != nil {
		return "", fmt.Errorf("cannot sync SAP runtime configuration")
	}
	return f.Name(), nil
}

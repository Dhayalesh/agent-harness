package manifest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var validIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_\-\.]+$`)
var validDestinationPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_\-\.]*$`)
var forbiddenShellChars = regexp.MustCompile(`[;&|<>$` + "`" + `\n\r]`)

// RestartPolicy defines process crash recovery and restart rate-limiting rules.
type RestartPolicy struct {
	MaxRestarts    int           `json:"maxRestarts" yaml:"maxRestarts"`
	CrashWindow    time.Duration `json:"crashWindow" yaml:"crashWindow"`
	InitialBackoff time.Duration `json:"initialBackoff" yaml:"initialBackoff"`
	MaxBackoff     time.Duration `json:"maxBackoff" yaml:"maxBackoff"`
}

// Manifest defines the declaration and runtime parameters of an MCP child process.
type Manifest struct {
	ID             string            `json:"id" yaml:"id"`
	Name           string            `json:"name" yaml:"name"`
	Version        string            `json:"version" yaml:"version"`
	Transport      string            `json:"transport" yaml:"transport"`
	Executable     string            `json:"executable" yaml:"executable"`
	Destination    string            `json:"destination,omitempty" yaml:"destination,omitempty"`
	EnvPath        string            `json:"envPath,omitempty" yaml:"envPath,omitempty"`
	SystemType     string            `json:"systemType,omitempty" yaml:"systemType,omitempty"`
	Arguments      []string          `json:"arguments" yaml:"arguments"`
	Env            map[string]string `json:"env" yaml:"env"`
	StartupTimeout time.Duration     `json:"startupTimeout" yaml:"startupTimeout"`
	RequestTimeout time.Duration     `json:"requestTimeout" yaml:"requestTimeout"`
	RestartPolicy  RestartPolicy     `json:"restartPolicy" yaml:"restartPolicy"`
	AllowedTools   []string          `json:"allowedTools" yaml:"allowedTools"`
}

// DefaultRestartPolicy returns safe defaults for process supervisor.
func DefaultRestartPolicy() RestartPolicy {
	return RestartPolicy{
		MaxRestarts:    5,
		CrashWindow:    60 * time.Second,
		InitialBackoff: 1 * time.Second,
		MaxBackoff:     30 * time.Second,
	}
}

// Validate checks that the manifest is well-formed, safe to execute, and strictly bounded.
func (m *Manifest) Validate() error {
	if m.ID == "" {
		return fmt.Errorf("manifest id cannot be empty")
	}
	if !validIDPattern.MatchString(m.ID) {
		return fmt.Errorf("manifest id '%s' contains invalid characters; must be alphanumeric, hyphen, underscore, or period", m.ID)
	}
	if m.Destination != "" && !validDestinationPattern.MatchString(m.Destination) {
		return fmt.Errorf("manifest destination '%s' contains invalid characters; must start with alphanumeric and contain only alphanumeric, hyphen, underscore, or period", m.Destination)
	}
	if m.EnvPath != "" && forbiddenShellChars.MatchString(m.EnvPath) {
		return fmt.Errorf("manifest envPath '%s' contains forbidden shell characters", m.EnvPath)
	}
	if m.SystemType != "" && forbiddenShellChars.MatchString(m.SystemType) {
		return fmt.Errorf("manifest systemType '%s' contains forbidden shell characters", m.SystemType)
	}
	if m.Executable == "" {
		return fmt.Errorf("manifest executable cannot be empty")
	}
	if forbiddenShellChars.MatchString(m.Executable) {
		return fmt.Errorf("manifest executable '%s' contains forbidden shell characters", m.Executable)
	}
	for _, arg := range m.Arguments {
		if forbiddenShellChars.MatchString(arg) {
			return fmt.Errorf("manifest argument '%s' contains forbidden shell characters", arg)
		}
	}
	if m.Transport != "stdio" {
		return fmt.Errorf("unsupported transport '%s'; only 'stdio' is supported in this release", m.Transport)
	}

	if m.StartupTimeout <= 0 {
		m.StartupTimeout = 30 * time.Second
	}
	if m.RequestTimeout <= 0 {
		m.RequestTimeout = 60 * time.Second
	}

	if m.RestartPolicy.MaxRestarts < 0 {
		m.RestartPolicy.MaxRestarts = 0
	}
	if m.RestartPolicy.CrashWindow <= 0 {
		m.RestartPolicy.CrashWindow = 60 * time.Second
	}
	if m.RestartPolicy.InitialBackoff <= 0 {
		m.RestartPolicy.InitialBackoff = 1 * time.Second
	}
	if m.RestartPolicy.MaxBackoff <= 0 {
		m.RestartPolicy.MaxBackoff = 30 * time.Second
	}

	return nil
}

// ResolveEnvPath resolves the configured env-file path, supporting relative paths and absolute Windows paths.
func (m *Manifest) ResolveEnvPath() string {
	if m.EnvPath == "" {
		return ""
	}
	clean := filepath.Clean(m.EnvPath)
	if filepath.IsAbs(clean) {
		return clean
	}
	abs, err := filepath.Abs(clean)
	if err == nil {
		return abs
	}
	return clean
}

// EffectiveArguments returns arguments with transport, env-path, system-type, and destination parameters merged if configured.
func (m *Manifest) EffectiveArguments() []string {
	args := make([]string, len(m.Arguments))
	copy(args, m.Arguments)

	// Merge --env-path if configured
	if m.EnvPath != "" {
		hasEnvPath := false
		for _, a := range args {
			if strings.HasPrefix(a, "--env-path=") || a == "--env-path" {
				hasEnvPath = true
				break
			}
		}
		if !hasEnvPath {
			resolved := m.ResolveEnvPath()
			args = append(args, fmt.Sprintf("--env-path=%s", resolved))
		}
	}

	// Merge --system-type if configured
	if m.SystemType != "" {
		hasSystemType := false
		for _, a := range args {
			if strings.HasPrefix(a, "--system-type=") || a == "--system-type" {
				hasSystemType = true
				break
			}
		}
		if !hasSystemType {
			args = append(args, fmt.Sprintf("--system-type=%s", m.SystemType))
		}
	}

	// Merge --mcp=<destination> if destination is configured
	if m.Destination != "" {
		hasDestinationArg := false
		for _, a := range args {
			if strings.HasPrefix(a, "--mcp=") || a == "--mcp" {
				hasDestinationArg = true
				break
			}
		}
		if !hasDestinationArg {
			args = append(args, fmt.Sprintf("--mcp=%s", m.Destination))
		}
	}

	return args
}

// EffectiveEnv returns the child process environment as declared in the manifest.
// Edge does not inject unverified environment variables such as SAP_DESTINATION.
func (m *Manifest) EffectiveEnv() map[string]string {
	env := make(map[string]string, len(m.Env))
	for k, v := range m.Env {
		env[k] = v
	}
	return env
}

// ResolveExecutable resolves the executable location, prioritizing local non-admin runtime and bin directories.
func (m *Manifest) ResolveExecutable() string {
	execPath := m.Executable
	if filepath.IsAbs(execPath) {
		return execPath
	}

	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData != "" {
		// Prioritize embedded/extracted standalone runtime
		if execPath == "sap-adt-host" || execPath == "sap-adt-host.exe" || execPath == "mcp-abap-adt" {
			candRuntime := filepath.Join(localAppData, "TrueAI", "Edge", "runtime", "sap-adt-host.exe")
			if _, err := os.Stat(candRuntime); err == nil {
				return candRuntime
			}
		}

		candRuntime := filepath.Join(localAppData, "TrueAI", "Edge", "runtime", execPath)
		if _, err := os.Stat(candRuntime); err == nil {
			return candRuntime
		}
		if _, err := os.Stat(candRuntime + ".exe"); err == nil {
			return candRuntime + ".exe"
		}

		// Check %LOCALAPPDATA%\TrueAI\Edge\bin\<executable>
		candBin := filepath.Join(localAppData, "TrueAI", "Edge", "bin", execPath)
		if _, err := os.Stat(candBin); err == nil {
			return candBin
		}
		if _, err := os.Stat(candBin + ".exe"); err == nil {
			return candBin + ".exe"
		}
	}

	// Check relative to current working directory
	if _, err := os.Stat(execPath); err == nil {
		return execPath
	}
	if _, err := os.Stat(execPath + ".exe"); err == nil {
		return execPath + ".exe"
	}

	return execPath
}

// LoadFromFile reads and parses a manifest from a YAML or JSON file.
func LoadFromFile(filePath string) (*Manifest, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read manifest file %s: %w", filePath, err)
	}

	ext := filepath.Ext(filePath)
	m, err := LoadFromBytes(data, ext)
	if err != nil {
		return nil, fmt.Errorf("failed to load manifest %s: %w", filePath, err)
	}

	return m, nil
}

// LoadFromBytes parses and validates a manifest from raw YAML or JSON bytes.
func LoadFromBytes(data []byte, ext string) (*Manifest, error) {
	ext = strings.ToLower(ext)
	var m *Manifest
	var err error

	if ext == ".json" {
		m, err = parseJSON(data)
	} else {
		// Attempt YAML parsing first; if it looks like JSON or fails, fallback to JSON
		m, err = parseYAML(string(data))
		if err != nil && strings.HasPrefix(strings.TrimSpace(string(data)), "{") {
			m, err = parseJSON(data)
		}
	}

	if err != nil {
		return nil, fmt.Errorf("failed to parse manifest data: %w", err)
	}

	if err := m.Validate(); err != nil {
		return nil, fmt.Errorf("invalid manifest: %w", err)
	}

	return m, nil
}

// parseJSON unmarshals manifest from JSON with duration string support.
func parseJSON(data []byte) (*Manifest, error) {
	var raw struct {
		ID             string            `json:"id"`
		Name           string            `json:"name"`
		Version        string            `json:"version"`
		Transport      string            `json:"transport"`
		Executable     string            `json:"executable"`
		Destination    string            `json:"destination"`
		EnvPath        string            `json:"envPath"`
		EnvFile        string            `json:"envFile"`
		SystemType     string            `json:"systemType"`
		Arguments      []string          `json:"arguments"`
		Env            map[string]string `json:"env"`
		StartupTimeout string            `json:"startupTimeout"`
		RequestTimeout string            `json:"requestTimeout"`
		RestartPolicy  struct {
			MaxRestarts    int    `json:"maxRestarts"`
			CrashWindow    string `json:"crashWindow"`
			InitialBackoff string `json:"initialBackoff"`
			MaxBackoff     string `json:"maxBackoff"`
		} `json:"restartPolicy"`
		AllowedTools []string `json:"allowedTools"`
	}

	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}

	envPath := raw.EnvPath
	if envPath == "" {
		envPath = raw.EnvFile
	}

	m := &Manifest{
		ID:           raw.ID,
		Name:         raw.Name,
		Version:      raw.Version,
		Transport:    raw.Transport,
		Executable:   raw.Executable,
		Destination:  raw.Destination,
		EnvPath:      envPath,
		SystemType:   raw.SystemType,
		Arguments:    raw.Arguments,
		Env:          raw.Env,
		AllowedTools: raw.AllowedTools,
		RestartPolicy: RestartPolicy{
			MaxRestarts: raw.RestartPolicy.MaxRestarts,
		},
	}

	if raw.StartupTimeout != "" {
		d, err := time.ParseDuration(raw.StartupTimeout)
		if err == nil {
			m.StartupTimeout = d
		}
	}
	if raw.RequestTimeout != "" {
		d, err := time.ParseDuration(raw.RequestTimeout)
		if err == nil {
			m.RequestTimeout = d
		}
	}
	if raw.RestartPolicy.CrashWindow != "" {
		d, err := time.ParseDuration(raw.RestartPolicy.CrashWindow)
		if err == nil {
			m.RestartPolicy.CrashWindow = d
		}
	}
	if raw.RestartPolicy.InitialBackoff != "" {
		d, err := time.ParseDuration(raw.RestartPolicy.InitialBackoff)
		if err == nil {
			m.RestartPolicy.InitialBackoff = d
		}
	}
	if raw.RestartPolicy.MaxBackoff != "" {
		d, err := time.ParseDuration(raw.RestartPolicy.MaxBackoff)
		if err == nil {
			m.RestartPolicy.MaxBackoff = d
		}
	}

	return m, nil
}

// parseYAML parses a standard manifest YAML without external dependencies.
func parseYAML(content string) (*Manifest, error) {
	m := &Manifest{
		Env:           make(map[string]string),
		RestartPolicy: DefaultRestartPolicy(),
	}

	scanner := bufio.NewScanner(strings.NewReader(content))
	var currentSection string

	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		// Handle list items
		if strings.HasPrefix(trimmed, "- ") {
			itemVal := strings.TrimSpace(trimmed[2:])
			itemVal = unquote(itemVal)
			switch currentSection {
			case "arguments":
				m.Arguments = append(m.Arguments, itemVal)
			case "allowedTools":
				m.AllowedTools = append(m.AllowedTools, itemVal)
			}
			continue
		}

		colonIdx := strings.Index(trimmed, ":")
		if colonIdx == -1 {
			continue
		}

		key := strings.TrimSpace(trimmed[:colonIdx])
		val := strings.TrimSpace(trimmed[colonIdx+1:])
		val = unquote(val)

		// Check indent to detect sub-blocks
		indent := len(line) - len(strings.TrimLeft(line, " \t"))

		if indent == 0 {
			currentSection = key
			switch key {
			case "id":
				m.ID = val
			case "name":
				m.Name = val
			case "version":
				m.Version = val
			case "transport":
				m.Transport = val
			case "executable":
				m.Executable = val
			case "destination":
				m.Destination = val
			case "envPath", "envFile":
				m.EnvPath = val
			case "systemType":
				m.SystemType = val
			case "startupTimeout":
				if d, err := time.ParseDuration(val); err == nil {
					m.StartupTimeout = d
				}
			case "requestTimeout":
				if d, err := time.ParseDuration(val); err == nil {
					m.RequestTimeout = d
				}
			}
		} else {
			// Sub-block parsing
			switch currentSection {
			case "restartPolicy":
				switch key {
				case "maxRestarts":
					if n, err := strconv.Atoi(val); err == nil {
						m.RestartPolicy.MaxRestarts = n
					}
				case "crashWindow":
					if d, err := time.ParseDuration(val); err == nil {
						m.RestartPolicy.CrashWindow = d
					}
				case "initialBackoff":
					if d, err := time.ParseDuration(val); err == nil {
						m.RestartPolicy.InitialBackoff = d
					}
				case "maxBackoff":
					if d, err := time.ParseDuration(val); err == nil {
						m.RestartPolicy.MaxBackoff = d
					}
				}
			case "env":
				m.Env[key] = val
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return m, nil
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && ((s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'')) {
		return s[1 : len(s)-1]
	}
	return s
}

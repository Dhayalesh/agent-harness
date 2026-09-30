package registry

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
)

// Registry manages trusted MCP manifests and their corresponding process instances.
type Registry struct {
	mu        sync.RWMutex
	manifests map[string]*manifest.Manifest
	pm        *process.ProcessManager
	logger    *slog.Logger
}

// NewRegistry creates a new Registry.
func NewRegistry(pm *process.ProcessManager, logger *slog.Logger) *Registry {
	if logger == nil {
		logger = slog.Default()
	}
	return &Registry{
		manifests: make(map[string]*manifest.Manifest),
		pm:        pm,
		logger:    logging.WithComponent(logger, logging.ComponentRegistry),
	}
}

// RegisterManifest registers and validates a manifest, creating an instance in the process manager.
func (r *Registry) RegisterManifest(m *manifest.Manifest) (*process.Instance, error) {
	if err := m.Validate(); err != nil {
		return nil, fmt.Errorf("invalid manifest '%s': %w", m.ID, err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.manifests[m.ID]; exists {
		return nil, fmt.Errorf("manifest with ID '%s' is already registered", m.ID)
	}

	inst, err := r.pm.Register(m)
	if err != nil {
		return nil, fmt.Errorf("failed to register process instance for '%s': %w", m.ID, err)
	}

	r.manifests[m.ID] = m
	r.logger.Info("Registered MCP manifest", "mcpId", m.ID, "name", m.Name, "version", m.Version)
	return inst, nil
}

// RegisterManifestBytes parses a manifest from raw bytes and registers it.
func (r *Registry) RegisterManifestBytes(data []byte, ext string) (*process.Instance, error) {
	m, err := manifest.LoadFromBytes(data, ext)
	if err != nil {
		return nil, fmt.Errorf("failed to load manifest from bytes: %w", err)
	}
	return r.RegisterManifest(m)
}

// LoadManifestsDir reads all .yaml and .json files in the specified directory and registers them.
func (r *Registry) LoadManifestsDir(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("cannot access manifest directory '%s': %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("manifest path '%s' is not a directory", dir)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("failed to read manifest directory '%s': %w", dir, err)
	}

	loadedCount := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".yaml" && ext != ".yml" && ext != ".json" {
			continue
		}

		fullPath := filepath.Join(dir, entry.Name())
		m, err := manifest.LoadFromFile(fullPath)
		if err != nil {
			r.logger.Warn("Failed to load manifest file", "file", fullPath, "error", err)
			continue
		}

		if _, err := r.RegisterManifest(m); err != nil {
			r.logger.Warn("Failed to register manifest", "file", fullPath, "mcpId", m.ID, "error", err)
			continue
		}
		loadedCount++
	}

	r.logger.Info("Loaded manifests from directory", "dir", dir, "count", loadedCount)
	return nil
}

// GetManifest returns the registered manifest for the given MCP ID.
func (r *Registry) GetManifest(id string) (*manifest.Manifest, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.manifests[id]
	return m, ok
}

// GetInstance returns the managed process instance for the given MCP ID.
func (r *Registry) GetInstance(id string) (*process.Instance, bool) {
	return r.pm.Get(id)
}

// ListManifests returns all registered manifests.
func (r *Registry) ListManifests() []*manifest.Manifest {
	r.mu.RLock()
	defer r.mu.RUnlock()

	res := make([]*manifest.Manifest, 0, len(r.manifests))
	for _, m := range r.manifests {
		res = append(res, m)
	}
	return res
}


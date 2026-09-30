package health

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/trueai/edge-connector/internal/mcp/process"
)

// EdgeHealth represents the aggregated health and operational status of Edge Connector.
type EdgeHealth struct {
	Status    string                    `json:"status"`
	Version   string                    `json:"version"`
	StartTime time.Time                 `json:"startTime"`
	Uptime    time.Duration             `json:"uptime"`
	MCPs      map[string]process.Status `json:"mcps"`
}

// Monitor aggregates health and process metrics across all registered MCPs.
type Monitor struct {
	mu        sync.RWMutex
	pm        *process.ProcessManager
	version   string
	startTime time.Time
}

// NewMonitor creates a new local health monitor.
func NewMonitor(pm *process.ProcessManager, version string) *Monitor {
	return &Monitor{
		pm:        pm,
		version:   version,
		startTime: time.Now(),
	}
}

// GetHealth returns a point-in-time health report for Edge and its supervised MCP processes.
func (m *Monitor) GetHealth() EdgeHealth {
	m.mu.RLock()
	defer m.mu.RUnlock()

	mcps := make(map[string]process.Status)
	allRunning := true
	hasCrashed := false

	if m.pm != nil {
		for _, inst := range m.pm.All() {
			st := inst.Status()
			mcps[st.ID] = st
			if st.State == process.StateCrashed {
				hasCrashed = true
			}
			if st.State != process.StateRunning {
				allRunning = false
			}
		}
	}

	overallStatus := "healthy"
	if hasCrashed {
		overallStatus = "degraded"
	} else if len(mcps) > 0 && !allRunning {
		overallStatus = "starting"
	} else if len(mcps) == 0 {
		overallStatus = "idle"
	}

	return EdgeHealth{
		Status:    overallStatus,
		Version:   m.version,
		StartTime: m.startTime,
		Uptime:    time.Since(m.startTime),
		MCPs:      mcps,
	}
}

// FormatSummary writes a human-readable health summary table to the provided writer.
func (m *Monitor) FormatSummary(w io.Writer) error {
	h := m.GetHealth()

	fmt.Fprintf(w, "=== True.ai Edge Connector Health Status ===\n")
	fmt.Fprintf(w, "Overall Status : %s\n", h.Status)
	fmt.Fprintf(w, "Edge Version   : %s\n", h.Version)
	fmt.Fprintf(w, "Uptime         : %s\n", h.Uptime.Round(time.Second))
	fmt.Fprintf(w, "--------------------------------------------\n")
	fmt.Fprintf(w, "%-15s %-12s %-8s %-10s %-8s %s\n", "MCP ID", "STATE", "PID", "UPTIME", "RESTARTS", "LAST ERROR")

	if len(h.MCPs) == 0 {
		fmt.Fprintf(w, "(No MCP processes configured)\n")
		return nil
	}

	for id, st := range h.MCPs {
		lastErr := st.LastError
		if lastErr == "" {
			lastErr = "-"
		}
		fmt.Fprintf(w, "%-15s %-12s %-8d %-10s %-8d %s\n",
			id,
			st.State,
			st.PID,
			st.Uptime.Round(time.Second),
			st.RestartCount,
			lastErr,
		)
	}
	return nil
}

// FormatJSON outputs the health status as formatted JSON.
func (m *Monitor) FormatJSON() ([]byte, error) {
	h := m.GetHealth()
	return json.MarshalIndent(h, "", "  ")
}


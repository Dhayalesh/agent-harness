package process

import (
	"time"
)

// State represents the lifecycle status of an MCP process.
type State string

const (
	StateStopped     State = "stopped"
	StateStarting    State = "starting"
	StateRunning     State = "running"
	StateTerminating State = "terminating"
	StateCrashed     State = "crashed"
)

// Status provides a thread-safe snapshot of MCP process metrics and lifecycle.
type Status struct {
	ID           string        `json:"id"`
	PID          int           `json:"pid"`
	StartTime    time.Time     `json:"startTime"`
	Uptime       time.Duration `json:"uptime"`
	State        State         `json:"state"`
	RestartCount int           `json:"restartCount"`
	LastExitCode int           `json:"lastExitCode"`
	LastError    string        `json:"lastError,omitempty"`
}


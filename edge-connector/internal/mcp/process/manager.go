package process

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
)

var (
	ErrProcessAlreadyRunning = errors.New("mcp process is already running")
	ErrProcessNotRunning     = errors.New("mcp process is not running")
	ErrRestartLoopDetected   = errors.New("mcp process restart loop detected")
)

// Instance manages the supervised lifecycle of a single MCP child process.
type Instance struct {
	mu sync.RWMutex

	manifest *manifest.Manifest
	cmd      *exec.Cmd
	client   *protocol.Client
	stdin    io.WriteCloser

	// Discovered tools
	tools      []protocol.ToolDefinition
	serverInfo protocol.ServerInfo
	launchEnv  func() (string, func(), error)

	// Lifecycle metrics
	state        State
	pid          int
	startTime    time.Time
	restartCount int
	lastExitCode int
	lastError    string

	// Supervision
	crashHistory  []time.Time
	stopRequested bool
	stopSignal    chan struct{}
	waitDone      chan struct{}

	logger *slog.Logger
}

// NewInstance creates a new managed MCP process instance.
func NewInstance(m *manifest.Manifest, logger *slog.Logger) *Instance {
	if logger == nil {
		logger = slog.Default()
	}

	return &Instance{
		manifest:   m,
		state:      StateStopped,
		stopSignal: make(chan struct{}),
		waitDone:   make(chan struct{}),
		logger:     logging.WithMCP(logging.WithComponent(logger, logging.ComponentProcess), m.ID),
	}
}

// Manifest returns the configuration manifest for this instance.
func (inst *Instance) Manifest() *manifest.Manifest {
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	return inst.manifest
}

// Status returns a point-in-time snapshot of the process status.
func (inst *Instance) Status() Status {
	inst.mu.RLock()
	defer inst.mu.RUnlock()

	var uptime time.Duration
	if inst.state == StateRunning && !inst.startTime.IsZero() {
		uptime = time.Since(inst.startTime)
	}

	return Status{
		ID:           inst.manifest.ID,
		PID:          inst.pid,
		StartTime:    inst.startTime,
		Uptime:       uptime,
		State:        inst.state,
		RestartCount: inst.restartCount,
		LastExitCode: inst.lastExitCode,
		LastError:    inst.lastError,
	}
}

// Tools returns the list of dynamically discovered tools.
func (inst *Instance) Tools() []protocol.ToolDefinition {
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	cp := make([]protocol.ToolDefinition, len(inst.tools))
	for i, t := range inst.tools {
		cp[i] = copyTool(t)
	}
	return cp
}

// ServerInfo returns the identity obtained in the MCP initialize handshake.
func (inst *Instance) ServerInfo() protocol.ServerInfo {
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	return inst.serverInfo
}

// SetLaunchEnvironment supplies a fresh, short-lived host env file on every
// launch, including supervisor restarts. The cleanup runs after discovery.
func (inst *Instance) SetLaunchEnvironment(prepare func() (string, func(), error)) {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.launchEnv = prepare
}

// GetTool returns the tool definition for a given tool name if discovered.
func (inst *Instance) GetTool(name string) (protocol.ToolDefinition, bool) {
	inst.mu.RLock()
	defer inst.mu.RUnlock()

	// 1. Exact match
	for _, t := range inst.tools {
		if t.Name == name {
			return copyTool(t), true
		}
	}

	// 2. Case-insensitive fallback
	for _, t := range inst.tools {
		if strings.EqualFold(t.Name, name) {
			return copyTool(t), true
		}
	}

	return protocol.ToolDefinition{}, false
}

// DescribeTool formats the name, description, and input schema for a discovered tool.
func (inst *Instance) DescribeTool(name string) (string, error) {
	t, ok := inst.GetTool(name)
	if !ok {
		tools := inst.Tools()
		available := make([]string, len(tools))
		for i, tool := range tools {
			available[i] = tool.Name
		}
		if len(available) > 10 {
			return "", fmt.Errorf("tool '%s' not found among %d discovered tools (first 10: %v...)", name, len(tools), available[:10])
		}
		return "", fmt.Errorf("tool '%s' not found among %d discovered tools (available: %v)", name, len(tools), available)
	}
	return t.FormatDescription(), nil
}

func copyTool(t protocol.ToolDefinition) protocol.ToolDefinition {
	cp := t
	if t.InputSchema != nil {
		schemaCopy := make([]byte, len(t.InputSchema))
		copy(schemaCopy, t.InputSchema)
		cp.InputSchema = schemaCopy
	}
	return cp
}

// Client returns the active JSON-RPC protocol client.
func (inst *Instance) Client() *protocol.Client {
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	return inst.client
}

// Start launches the MCP child process and performs the handshake.
func (inst *Instance) Start(ctx context.Context) error {
	inst.mu.Lock()
	if inst.state == StateRunning || inst.state == StateStarting {
		inst.mu.Unlock()
		return ErrProcessAlreadyRunning
	}

	inst.state = StateStarting
	inst.stopRequested = false
	inst.stopSignal = make(chan struct{})
	inst.waitDone = make(chan struct{})
	inst.mu.Unlock()

	inst.mu.RLock()
	prepare := inst.launchEnv
	inst.mu.RUnlock()
	launchManifest := *inst.manifest
	if prepare != nil {
		path, cleanup, err := prepare()
		if err != nil {
			inst.setFailedState("SAP runtime configuration unavailable")
			return fmt.Errorf("SAP runtime configuration unavailable")
		}
		if cleanup != nil {
			defer cleanup()
		}
		launchManifest.EnvPath = path
	}
	executable := launchManifest.ResolveExecutable()
	arguments := launchManifest.EffectiveArguments()
	envMap := inst.manifest.EffectiveEnv()

	inst.logger.Info("Starting MCP child process",
		"executable", executable,
		"arguments", arguments,
		"destination", inst.manifest.Destination,
	)

	cmd := exec.Command(executable, arguments...)

	// Configure environment (inherit parent OS env and merge manifest env)
	cmd.Env = os.Environ()
	for k, v := range envMap {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		inst.setFailedState("failed to open stdin pipe: " + err.Error())
		return err
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		inst.setFailedState("failed to open stdout pipe: " + err.Error())
		return err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		inst.setFailedState("failed to open stderr pipe: " + err.Error())
		return err
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		inst.setFailedState("failed to start process: " + err.Error())
		return err
	}

	inst.mu.Lock()
	inst.cmd = cmd
	inst.stdin = stdin
	inst.pid = cmd.Process.Pid
	inst.startTime = time.Now()
	inst.mu.Unlock()

	// Drain stderr in background to structured logger
	go inst.drainStderr(stderr)

	// Initialize protocol client over stdout and stdin
	client := protocol.NewClient(stdout, stdin, inst.logger)

	// Perform initialize and tool discovery within startup timeout
	initCtx, cancelInit := context.WithTimeout(ctx, inst.manifest.StartupTimeout)
	defer cancelInit()

	initResult, err := client.Initialize(initCtx, "TrueAI-Edge", "1.0.0")
	if err != nil {
		inst.logger.Error("MCP initialize handshake failed", "error", err)
		_ = inst.terminateProcess(5 * time.Second)
		inst.setFailedState("handshake failed: " + err.Error())
		return fmt.Errorf("mcp initialize failed: %w", err)
	}

	inst.logger.Info("MCP handshake succeeded",
		"serverName", initResult.ServerInfo.Name,
		"serverVersion", initResult.ServerInfo.Version,
	)
	inst.mu.Lock()
	inst.serverInfo = initResult.ServerInfo
	inst.mu.Unlock()

	// Discover tools dynamically
	toolsResult, err := client.ListTools(initCtx)
	if err != nil {
		inst.logger.Warn("Failed to list tools during startup", "error", err)
	} else {
		inst.mu.Lock()
		inst.tools = toolsResult.Tools
		inst.mu.Unlock()

		toolNames := make([]string, len(toolsResult.Tools))
		for i, t := range toolsResult.Tools {
			toolNames[i] = t.Name
			inst.logger.Debug("Discovered MCP tool",
				"tool", t.Name,
				"description", t.Description,
				"hasSchema", len(t.InputSchema) > 0,
			)
		}

		inst.logger.Info("Discovered tools dynamically",
			"count", len(toolsResult.Tools),
			"tools", toolNames,
		)
	}

	inst.mu.Lock()
	inst.client = client
	inst.state = StateRunning
	inst.lastError = ""
	inst.mu.Unlock()

	// Start supervisor goroutine to monitor exit and crashes
	go inst.superviseProcess(cmd)

	return nil
}

// drainStderr streams stderr from the child process into structured logs.
func (inst *Instance) drainStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		inst.logger.Debug("MCP child stderr received")
	}
}

// superviseProcess monitors the child process exit and triggers crash recovery.
func (inst *Instance) superviseProcess(cmd *exec.Cmd) {
	err := cmd.Wait()

	inst.mu.Lock()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}
	inst.lastExitCode = exitCode
	wasRequested := inst.stopRequested
	inst.mu.Unlock()

	if wasRequested {
		inst.mu.Lock()
		inst.state = StateStopped
		inst.pid = 0
		inst.mu.Unlock()
		inst.logger.Info("MCP child process stopped gracefully", "exitCode", exitCode)
		close(inst.waitDone)
		return
	}

	close(inst.waitDone)

	// Unexpected exit (crash)
	inst.handleCrash(err, exitCode)
}

// handleCrash evaluates the crash against restart policy and attempts backoff restart.
func (inst *Instance) handleCrash(err error, exitCode int) {
	inst.mu.Lock()
	inst.state = StateCrashed
	errMsg := fmt.Sprintf("process exited unexpectedly with code %d", exitCode)
	if err != nil {
		errMsg += ": " + err.Error()
	}
	inst.lastError = errMsg
	now := time.Now()
	inst.crashHistory = append(inst.crashHistory, now)

	// Filter crashes within CrashWindow
	windowStart := now.Add(-inst.manifest.RestartPolicy.CrashWindow)
	recentCrashes := make([]time.Time, 0, len(inst.crashHistory))
	for _, t := range inst.crashHistory {
		if t.After(windowStart) {
			recentCrashes = append(recentCrashes, t)
		}
	}
	inst.crashHistory = recentCrashes
	crashCount := len(recentCrashes)

	if crashCount > inst.manifest.RestartPolicy.MaxRestarts {
		inst.lastError = fmt.Sprintf("restart loop detected: exceeded %d crashes in %v",
			inst.manifest.RestartPolicy.MaxRestarts, inst.manifest.RestartPolicy.CrashWindow)
		inst.mu.Unlock()

		inst.logger.Error("Restart-loop protection engaged; aborting automatic restart",
			"recentCrashes", crashCount,
			"window", inst.manifest.RestartPolicy.CrashWindow,
		)
		return
	}

	inst.restartCount++
	currentRestart := inst.restartCount

	// Calculate exponential backoff: initialBackoff * 2^(recentCrashes - 1)
	backoff := inst.manifest.RestartPolicy.InitialBackoff
	for i := 1; i < crashCount; i++ {
		backoff *= 2
		if backoff > inst.manifest.RestartPolicy.MaxBackoff {
			backoff = inst.manifest.RestartPolicy.MaxBackoff
			break
		}
	}
	inst.mu.Unlock()

	inst.logger.Warn("MCP process crashed; scheduling restart with backoff",
		"exitCode", exitCode,
		"restartCount", currentRestart,
		"backoff", backoff,
	)

	select {
	case <-time.After(backoff):
	case <-inst.stopSignal:
		return
	}

	// Attempt restart
	if err := inst.Start(context.Background()); err != nil {
		inst.logger.Error("Automatic restart attempt failed", "error", err)
	}
}

// Stop gracefully shuts down the child process.
func (inst *Instance) Stop(ctx context.Context) error {
	inst.mu.Lock()
	if inst.state != StateRunning && inst.state != StateStarting {
		inst.mu.Unlock()
		return nil
	}
	inst.state = StateTerminating
	inst.stopRequested = true
	close(inst.stopSignal)
	inst.mu.Unlock()

	inst.logger.Info("Stopping MCP process gracefully")

	// Close protocol client
	if inst.client != nil {
		_ = inst.client.Close()
	}

	// Close stdin pipe to signal EOF to child
	if inst.stdin != nil {
		_ = inst.stdin.Close()
	}

	// Wait for process to exit or context/grace period to expire
	select {
	case <-inst.waitDone:
		// Clean exit
	case <-ctx.Done():
		_ = inst.terminateProcess(2 * time.Second)
	case <-time.After(5 * time.Second):
		inst.logger.Warn("Process did not exit after grace period; forcing kill")
		_ = inst.terminateProcess(2 * time.Second)
	}

	inst.mu.Lock()
	inst.state = StateStopped
	inst.pid = 0
	inst.mu.Unlock()

	return nil
}

// Restart stops and re-starts the process.
func (inst *Instance) Restart(ctx context.Context) error {
	if err := inst.Stop(ctx); err != nil {
		return fmt.Errorf("failed to stop during restart: %w", err)
	}
	return inst.Start(ctx)
}

// terminateProcess sends kill signal to process if still running.
func (inst *Instance) terminateProcess(timeout time.Duration) error {
	inst.mu.Lock()
	cmd := inst.cmd
	inst.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		return nil
	}

	_ = cmd.Process.Kill()

	select {
	case <-inst.waitDone:
		return nil
	case <-time.After(timeout):
		return fmt.Errorf("timeout waiting for process to terminate")
	}
}

func (inst *Instance) setFailedState(errMsg string) {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	inst.state = StateCrashed
	inst.lastError = errMsg
}

// ProcessManager manages multiple MCP process instances.
type ProcessManager struct {
	mu        sync.RWMutex
	instances map[string]*Instance
	logger    *slog.Logger
}

// NewProcessManager creates a new ProcessManager.
func NewProcessManager(logger *slog.Logger) *ProcessManager {
	if logger == nil {
		logger = slog.Default()
	}
	return &ProcessManager{
		instances: make(map[string]*Instance),
		logger:    logging.WithComponent(logger, logging.ComponentProcess),
	}
}

// Register registers an MCP manifest and prepares an instance.
func (pm *ProcessManager) Register(m *manifest.Manifest) (*Instance, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if _, exists := pm.instances[m.ID]; exists {
		return nil, fmt.Errorf("mcp instance '%s' already registered", m.ID)
	}

	inst := NewInstance(m, pm.logger)
	pm.instances[m.ID] = inst
	return inst, nil
}

// Get returns the managed instance for the given MCP ID.
func (pm *ProcessManager) Get(id string) (*Instance, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	inst, ok := pm.instances[id]
	return inst, ok
}

// All returns all registered instances.
func (pm *ProcessManager) All() []*Instance {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	list := make([]*Instance, 0, len(pm.instances))
	for _, inst := range pm.instances {
		list = append(list, inst)
	}
	return list
}

// StopAll stops all registered MCP processes concurrently.
func (pm *ProcessManager) StopAll(ctx context.Context) {
	pm.mu.RLock()
	instances := make([]*Instance, 0, len(pm.instances))
	for _, inst := range pm.instances {
		instances = append(instances, inst)
	}
	pm.mu.RUnlock()

	var wg sync.WaitGroup
	for _, inst := range instances {
		wg.Add(1)
		go func(i *Instance) {
			defer wg.Done()
			_ = i.Stop(ctx)
		}(inst)
	}
	wg.Wait()
}

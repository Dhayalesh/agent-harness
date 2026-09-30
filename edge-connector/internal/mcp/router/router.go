package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/protocol"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/policy"
)

var (
	ErrRouterShuttingDown = errors.New("router is shutting down; new requests not accepted")
	ErrUnknownMCP         = errors.New("unknown mcp id")
	ErrMCPUnavailable     = errors.New("mcp process is unavailable")
)

// CallRequest defines an incoming tool execution request to be routed to an MCP.
type CallRequest struct {
	RequestID string                 `json:"requestId"`
	MCPID     string                 `json:"mcpId"`
	Tool      string                 `json:"tool"`
	Arguments map[string]interface{} `json:"arguments,omitempty"`
	Timeout   time.Duration          `json:"timeout,omitempty"`
}

// CallResponse represents the output of a routed tool execution.
type CallResponse struct {
	RequestID string                    `json:"requestId"`
	MCPID     string                    `json:"mcpId"`
	Tool      string                    `json:"tool"`
	Result    *protocol.ToolsCallResult `json:"result,omitempty"`
	Duration  time.Duration             `json:"duration"`
	IsError   bool                      `json:"isError"`
}

// Router dispatches validated tool call requests deterministically to managed MCP processes.
type Router struct {
	registry *registry.Registry
	policy   *policy.Engine
	logger   *slog.Logger

	inFlight sync.WaitGroup
	closing  atomic.Bool
}

// NewRouter creates a new deterministic MCP router.
func NewRouter(reg *registry.Registry, pol *policy.Engine, logger *slog.Logger) *Router {
	if logger == nil {
		logger = slog.Default()
	}
	return &Router{
		registry: reg,
		policy:   pol,
		logger:   logging.WithComponent(logger, logging.ComponentRouter),
	}
}

// Route executes the full deterministic routing pipeline.
func (r *Router) Route(ctx context.Context, req CallRequest) (*CallResponse, error) {
	if r.closing.Load() {
		return nil, ErrRouterShuttingDown
	}

	r.inFlight.Add(1)
	defer r.inFlight.Done()

	start := time.Now()
	reqLogger := logging.WithRequest(r.logger, req.MCPID, req.RequestID)

	// Step 1: Prevent arbitrary shell/process injection parameters
	if err := r.policy.ValidateArguments(req.Arguments); err != nil {
		reqLogger.Error("Rejected tool call: illegal execution parameters", "error", err)
		return nil, err
	}

	// Step 2: Validate MCP ID against local policy
	if err := r.policy.ValidateMCP(req.MCPID); err != nil {
		reqLogger.Error("Rejected tool call: disallowed MCP", "error", err)
		return nil, err
	}

	// Step 3: Lookup manifest in local registry
	manifest, ok := r.registry.GetManifest(req.MCPID)
	if !ok {
		reqLogger.Error("Rejected tool call: MCP not registered", "mcpId", req.MCPID)
		return nil, fmt.Errorf("%w: '%s'", ErrUnknownMCP, req.MCPID)
	}

	// Step 4: Lookup managed process instance
	inst, ok := r.registry.GetInstance(req.MCPID)
	if !ok {
		reqLogger.Error("Rejected tool call: instance missing", "mcpId", req.MCPID)
		return nil, fmt.Errorf("%w: instance for '%s'", ErrMCPUnavailable, req.MCPID)
	}

	// Step 5: Ensure MCP child process is running
	status := inst.Status()
	if status.State == process.StateStopped {
		reqLogger.Info("Starting MCP child process on-demand", "mcpId", req.MCPID)
		if err := inst.Start(ctx); err != nil {
			reqLogger.Error("Failed to start MCP process", "error", err)
			return nil, fmt.Errorf("%w: failed to start process: %v", ErrMCPUnavailable, err)
		}
	} else if status.State != process.StateRunning {
		reqLogger.Error("MCP process is not ready", "state", status.State, "lastError", status.LastError)
		return nil, fmt.Errorf("%w: process state is %s (%s)", ErrMCPUnavailable, status.State, status.LastError)
	}

	client := inst.Client()
	if client == nil {
		return nil, fmt.Errorf("%w: protocol client unavailable", ErrMCPUnavailable)
	}

	// Step 6: Validate requested tool against policy & dynamic MCP tool list
	discovered := inst.Tools()
	toolNames := make([]string, len(discovered))
	for i, t := range discovered {
		toolNames[i] = t.Name
	}

	if err := r.policy.ValidateTool(req.MCPID, req.Tool, toolNames); err != nil {
		reqLogger.Error("Rejected tool call: policy tool check failed", "tool", req.Tool, "error", err)
		return nil, err
	}

	// Step 7: Enforce deterministic timeout
	timeout := manifest.RequestTimeout
	if req.Timeout > 0 && req.Timeout < timeout {
		timeout = req.Timeout
	}
	callCtx, cancelCall := context.WithTimeout(ctx, timeout)
	defer cancelCall()

	reqLogger.Info("Dispatching tools/call to MCP", "tool", req.Tool, "timeout", timeout)

	// Step 8: Execute MCP tool call over JSON-RPC 2.0 stdio
	callResult, err := client.CallTool(callCtx, req.Tool, req.Arguments)
	duration := time.Since(start)

	if err != nil {
		reqLogger.Error("MCP tools/call failed", "tool", req.Tool, "duration", duration, "error", err)
		return nil, fmt.Errorf("mcp tools/call failed: %w", err)
	}

	// Step 9: Validate response payload size
	resultBytes, _ := json.Marshal(callResult)
	if err := r.policy.ValidateResponseSize(int64(len(resultBytes))); err != nil {
		reqLogger.Error("MCP response size limit exceeded", "size", len(resultBytes), "error", err)
		return nil, err
	}

	reqLogger.Info("MCP tools/call completed successfully", "tool", req.Tool, "duration", duration, "isError", callResult.IsError)

	return &CallResponse{
		RequestID: req.RequestID,
		MCPID:     req.MCPID,
		Tool:      req.Tool,
		Result:    callResult,
		Duration:  duration,
		IsError:   callResult.IsError,
	}, nil
}

// Close initiates router shutdown, waiting for active requests to finish or context to expire.
func (r *Router) Close(ctx context.Context) error {
	r.closing.Store(true)

	done := make(chan struct{})
	go func() {
		r.inFlight.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}


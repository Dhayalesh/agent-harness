package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/trueai/edge-connector-gui/internal/runtime"
)

const maxLine = 16 << 20

type Host struct {
	root      string
	logger    *slog.Logger
	mu        sync.Mutex
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	responses chan json.RawMessage
	done      chan struct{}
	nextID    uint64
	init      json.RawMessage
}

func New(root string, logger *slog.Logger) *Host {
	if logger == nil {
		logger = slog.Default()
	}
	return &Host{root: root, logger: logger}
}

func desktopEnv() []string {
	var env []string
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "BACKEND_TYPE=") {
			env = append(env, entry)
		}
	}
	return append(env, "BACKEND_TYPE=desktop")
}

func (h *Host) startLocked(ctx context.Context) error {
	if h.cmd != nil {
		select {
		case <-h.done:
			h.stopLocked()
		default:
			return nil
		}
	}
	path, err := runtime.EnsureExtracted(h.root)
	if err != nil {
		return err
	}
	cmd := exec.Command(path)
	cmd.Env = desktopEnv()
	cmd.Stderr = io.Discard // Upstream errors can contain sensitive SAP details.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	h.cmd, h.stdin = cmd, stdin
	responses := make(chan json.RawMessage, 2)
	done := make(chan struct{})
	h.responses, h.done = responses, done
	h.nextID = 0
	h.init = nil
	go h.readLoop(stdout, responses)
	go func() { _ = cmd.Wait(); close(done) }()
	startup, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	init := map[string]any{"jsonrpc": "2.0", "method": "initialize", "params": map[string]any{
		"protocolVersion": "2025-03-26", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "edge-gui", "version": "0.1.0"}}}
	initRaw, _ := json.Marshal(init)
	response, err := h.exchangeLocked(startup, initRaw)
	if err != nil {
		h.stopLocked()
		return fmt.Errorf("upstream MCP initialize failed: %w", err)
	}
	var initialized struct {
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(response, &initialized) != nil || len(initialized.Result) == 0 || len(initialized.Error) > 0 {
		h.stopLocked()
		return errors.New("upstream MCP initialize returned an error")
	}
	h.init = response
	if err := h.sendLocked(json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); err != nil {
		h.stopLocked()
		return err
	}
	tools, err := h.exchangeLocked(startup, json.RawMessage(`{"jsonrpc":"2.0","method":"tools/list"}`))
	if err != nil {
		h.stopLocked()
		return fmt.Errorf("upstream tools/list failed: %w", err)
	}
	var listed struct {
		Result struct {
			Tools []json.RawMessage `json:"tools"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(tools, &listed) != nil || len(listed.Error) > 0 || listed.Result.Tools == nil {
		h.stopLocked()
		return errors.New("upstream tools/list returned an error")
	}
	h.logger.Info("SAP GUI MCP initialized", "mcpId", "sapgui", "toolsDiscovered", len(listed.Result.Tools))
	return nil
}

func (h *Host) readLoop(stdout io.Reader, responses chan<- json.RawMessage) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxLine+1)
	for scanner.Scan() {
		line := append(json.RawMessage(nil), scanner.Bytes()...)
		var m struct {
			ID json.RawMessage `json:"id"`
		}
		if json.Unmarshal(line, &m) == nil && len(m.ID) > 0 {
			select {
			case responses <- line:
			default:
			}
		}
	}
}

func (h *Host) sendLocked(raw json.RawMessage) error {
	if h.stdin == nil {
		return errors.New("upstream MCP process unavailable")
	}
	_, err := h.stdin.Write(append(append([]byte{}, raw...), '\n'))
	return err
}

func (h *Host) exchangeLocked(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	h.nextID++
	id := h.nextID
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, err
	}
	msg["id"], _ = json.Marshal(id)
	out, _ := json.Marshal(msg)
	if err := h.sendLocked(out); err != nil {
		return nil, err
	}
	for {
		select {
		case response := <-h.responses:
			var result struct {
				ID json.RawMessage `json:"id"`
			}
			if json.Unmarshal(response, &result) != nil {
				continue
			}
			var got uint64
			if json.Unmarshal(result.ID, &got) == nil && got == id {
				return response, nil
			}
		case <-h.done:
			return nil, errors.New("upstream MCP process exited")
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func replaceID(raw, id json.RawMessage) (json.RawMessage, error) {
	var result map[string]json.RawMessage
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	result["id"] = id
	return json.Marshal(result)
}

// Start initializes one persistent upstream MCP session and discovers real tools.
func (h *Host) Start(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.startLocked(ctx)
}

// Handle forwards an MCP request without altering result content or metadata.
func (h *Host) Handle(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var request struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
	}
	if json.Unmarshal(raw, &request) != nil || request.JSONRPC != "2.0" {
		return nil, errors.New("invalid MCP JSON-RPC request")
	}
	switch request.Method {
	case "initialize", "notifications/initialized", "tools/list", "tools/call", "ping":
	default:
		return nil, errors.New("unsupported MCP method")
	}
	if err := h.startLocked(ctx); err != nil {
		return nil, err
	}
	if request.Method == "notifications/initialized" {
		return nil, nil // Already sent as part of the upstream handshake.
	}
	if len(request.ID) == 0 {
		return nil, errors.New("MCP request ID required")
	}
	if request.Method == "initialize" {
		return replaceID(h.init, request.ID)
	}
	h.logger.Info("MCP request", "method", request.Method)
	response, err := h.exchangeLocked(ctx, raw)
	if err != nil {
		h.stopLocked()
		return nil, err
	}
	return replaceID(response, request.ID)
}

func (h *Host) stopLocked() {
	if h.cmd != nil && h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
		}
	}
	if h.stdin != nil {
		_ = h.stdin.Close()
	}
	h.cmd, h.stdin, h.responses, h.done, h.init = nil, nil, nil, nil, nil
}

func (h *Host) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.stopLocked()
}

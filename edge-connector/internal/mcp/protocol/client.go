package protocol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
)

var (
	ErrClientClosed     = errors.New("mcp protocol client closed")
	ErrResponseTimeout  = errors.New("mcp response timeout")
	ErrMalformedMessage = errors.New("malformed json-rpc message")
	ErrNullResponse     = errors.New("empty response received from mcp server")
)

// Client handles bidirectional JSON-RPC 2.0 communication over stdio reader/writer.
type Client struct {
	reader  *bufio.Reader
	writer  io.Writer
	writeMu sync.Mutex

	nextID uint64

	pendingMu sync.Mutex
	pending   map[uint64]chan *JSONRPCResponse

	closed   atomic.Bool
	done     chan struct{}
	closeErr error

	logger *slog.Logger
}

// NewClient creates a new MCP protocol client over the given reader (stdout) and writer (stdin).
func NewClient(r io.Reader, w io.Writer, logger *slog.Logger) *Client {
	if logger == nil {
		logger = slog.Default()
	}

	c := &Client{
		reader:  bufio.NewReader(r),
		writer:  w,
		pending: make(map[uint64]chan *JSONRPCResponse),
		done:    make(chan struct{}),
		logger:  logger,
	}

	go c.readLoop()
	return c
}

// readLoop continuously reads newline-delimited JSON-RPC messages from the server.
func (c *Client) readLoop() {
	defer func() {
		c.closed.Store(true)
		close(c.done)

		// Unblock all pending calls with nil response
		c.pendingMu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.pendingMu.Unlock()
	}()

	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil {
			if !errors.Is(err, io.EOF) && !c.closed.Load() {
				c.logger.Debug("readLoop terminated with error", "error", err)
			}
			c.closeErr = err
			return
		}

		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}

		var resp JSONRPCResponse
		if err := json.Unmarshal(trimmed, &resp); err != nil {
			c.logger.Warn("Failed to unmarshal server message as JSON-RPC response", "error", err)
			continue
		}

		// Dispatch to waiting pending request
		if resp.ID != nil {
			var id uint64
			switch v := resp.ID.(type) {
			case float64:
				id = uint64(v)
			case uint64:
				id = v
			case int64:
				id = uint64(v)
			case int:
				id = uint64(v)
			default:
				c.logger.Warn("Unsupported ID type in JSON-RPC response", "idType", fmt.Sprintf("%T", resp.ID))
				continue
			}

			c.pendingMu.Lock()
			ch, ok := c.pending[id]
			if ok {
				delete(c.pending, id)
			}
			c.pendingMu.Unlock()

			if ok && ch != nil {
				ch <- &resp
				close(ch)
			}
		}
	}
}

// send sends a raw JSON-RPC message newline-delimited to the writer.
func (c *Client) send(msg interface{}) error {
	if c.closed.Load() {
		return ErrClientClosed
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	data = append(data, '\n')
	if _, err := c.writer.Write(data); err != nil {
		return fmt.Errorf("failed to write message: %w", err)
	}

	return nil
}

// Request sends a JSON-RPC request and synchronously awaits the response or context cancellation.
func (c *Client) Request(ctx context.Context, method string, params interface{}) (*JSONRPCResponse, error) {
	if c.closed.Load() {
		return nil, ErrClientClosed
	}

	id := atomic.AddUint64(&c.nextID, 1)
	respChan := make(chan *JSONRPCResponse, 1)

	c.pendingMu.Lock()
	c.pending[id] = respChan
	c.pendingMu.Unlock()

	req := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	if err := c.send(req); err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}

	select {
	case <-ctx.Done():
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()

		// Send cancellation notification if context expired
		_ = c.Notify(MethodCancelRequest, CancelParams{
			RequestID: id,
			Reason:    "Context cancelled",
		})
		return nil, ctx.Err()

	case <-c.done:
		return nil, ErrClientClosed

	case resp, ok := <-respChan:
		if !ok || resp == nil {
			return nil, ErrClientClosed
		}
		if resp.Error != nil {
			return resp, resp.Error
		}
		return resp, nil
	}
}

// Notify sends a one-way JSON-RPC notification (no ID, does not wait for response).
func (c *Client) Notify(method string, params interface{}) error {
	req := JSONRPCRequest{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	return c.send(req)
}

// Initialize performs the standard MCP initialize handshake.
func (c *Client) Initialize(ctx context.Context, clientName, clientVersion string) (*InitializeResult, error) {
	params := InitializeParams{
		ProtocolVersion: CurrentProtocolVersion,
		Capabilities:    ClientCapabilities{},
		ClientInfo: ClientInfo{
			Name:    clientName,
			Version: clientVersion,
		},
	}

	resp, err := c.Request(ctx, MethodInitialize, params)
	if err != nil {
		return nil, fmt.Errorf("mcp initialize failed: %w", err)
	}

	var result InitializeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal initialize result: %w", err)
	}

	// Send initialized notification as required by MCP protocol
	if err := c.Notify(MethodInitialized, map[string]interface{}{}); err != nil {
		return nil, fmt.Errorf("failed to send initialized notification: %w", err)
	}

	return &result, nil
}

// ListTools queries the MCP server for its list of exposed tools.
func (c *Client) ListTools(ctx context.Context) (*ToolsListResult, error) {
	resp, err := c.Request(ctx, MethodToolsList, map[string]interface{}{})
	if err != nil {
		return nil, fmt.Errorf("mcp tools/list failed: %w", err)
	}

	var result ToolsListResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal tools/list result: %w", err)
	}

	return &result, nil
}

// CallTool executes a tool on the MCP server and returns the result.
func (c *Client) CallTool(ctx context.Context, name string, arguments map[string]interface{}) (*ToolsCallResult, error) {
	params := ToolsCallParams{
		Name:      name,
		Arguments: arguments,
	}

	resp, err := c.Request(ctx, MethodToolsCall, params)
	if err != nil {
		return nil, fmt.Errorf("mcp tools/call '%s' failed: %w", name, err)
	}

	var result ToolsCallResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal tools/call result: %w", err)
	}

	return &result, nil
}

// Close closes the client.
func (c *Client) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		// closing triggers done in readLoop if writer/reader are closed outside
	}
	return nil
}

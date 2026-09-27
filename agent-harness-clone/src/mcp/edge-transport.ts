import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';

/** Mirrors edge-server/internal/protocol/message.go: email belongs in Route, not Message. */
type EdgeResponse = {
  version: 1;
  requestId: string;
} & (
  | { type: 'harness.mcp.response'; payload: { message: JSONRPCMessage } }
  | { type: 'harness.mcp.error'; payload: { error: string } }
);

const RELAY_TIMEOUT_MS = 55_000; // Edge Server expires pending requests after 60 seconds.

export class EdgeClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private socket?: WebSocket;
  private closed = false;
  private readonly pending = new Map<string, { rpcId: string | number; timer: NodeJS.Timeout }>();

  constructor(
    private readonly url: URL,
    private readonly mcpId: string,
    private readonly email: string,
    private readonly serverName: string,
    private readonly connectTimeoutMs = RELAY_TIMEOUT_MS,
    private readonly logSink?: LogSink,
    private readonly logContext: LogContext = {},
  ) {}

  async start(): Promise<void> {
    if (this.socket) throw new Error('Edge transport already started');
    this.log('edge.mcp.connect');
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => this.finish(new Error('Edge WebSocket closed')));
    socket.addEventListener('error', () => this.fail(new Error('Edge WebSocket error')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(new Error('Edge WebSocket connection timed out'));
          void this.close();
        },
        Math.min(this.connectTimeoutMs, RELAY_TIMEOUT_MS),
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          this.log('edge.mcp.connected');
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer);
          reject(new Error('Edge WebSocket closed during connection'));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Edge WebSocket connection failed'));
        },
        { once: true },
      );
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Edge WebSocket is not open');
    }
    // The connector treats this notification as a no-op and returns JSON null.
    // MCP notifications have no JSON-RPC id, so relaying it would create an
    // Edge requestId with no valid MCP response to pass back to the SDK.
    if (
      'method' in message &&
      message.method === 'notifications/initialized' &&
      !('id' in message)
    ) {
      return;
    }
    if (!('id' in message) || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
      throw new Error('Edge transport only supports MCP requests with a JSON-RPC id');
    }
    const requestId = randomUUID();
    const timer = setTimeout(
      () => this.fail(new Error('Edge MCP request timed out')),
      RELAY_TIMEOUT_MS,
    );
    this.pending.set(requestId, { rpcId: message.id, timer });
    const envelope = {
      version: 1,
      type: 'harness.mcp.request',
      requestId,
      payload: { email: this.email, mcpId: this.mcpId, message },
    };
    this.log('edge.mcp.request', {
      edgeRequestId: requestId,
      method: 'method' in message ? message.method : undefined,
    });
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(requestId);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.socket?.close();
    } finally {
      this.finish();
    }
  }

  private receive(data: unknown): void {
    try {
      if (typeof data !== 'string') throw new Error('Edge response is not a text frame');
      const response: unknown = JSON.parse(data);
      if (!isEdgeResponse(response)) throw new Error('Malformed Edge response');
      const pending = this.pending.get(response.requestId);
      if (!pending) throw new Error('Unknown Edge requestId');
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.type === 'harness.mcp.error') {
        this.log('edge.mcp.error', {
          edgeRequestId: response.requestId,
          error: response.payload.error,
        });
        this.onmessage?.({
          jsonrpc: '2.0',
          id: pending.rpcId,
          error: { code: -32000, message: response.payload.error },
        });
        return;
      }
      const rpc = response.payload.message;
      if (
        !rpc ||
        typeof rpc !== 'object' ||
        !('id' in rpc) ||
        rpc.id !== pending.rpcId ||
        !('jsonrpc' in rpc) ||
        rpc.jsonrpc !== '2.0' ||
        (!('result' in rpc) && !('error' in rpc))
      ) {
        throw new Error('Malformed or mismatched Edge MCP response');
      }
      this.log('edge.mcp.response', { edgeRequestId: response.requestId });
      this.onmessage?.(rpc);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.log('edge.mcp.error', { error: error.message });
    this.onerror?.(error);
    void this.close().catch(() => undefined);
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.log('edge.mcp.closed', error ? { error: error.message } : {});
    this.onclose?.();
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    emitLog(this.logSink, {
      ...this.logContext,
      event,
      serverName: this.serverName,
      mcpId: this.mcpId,
      ...fields,
    });
  }
}

function isEdgeResponse(value: unknown): value is EdgeResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || typeof response.requestId !== 'string' || !response.requestId)
    return false;
  if (!response.payload || typeof response.payload !== 'object') return false;
  const payload = response.payload as Record<string, unknown>;
  return response.type === 'harness.mcp.response'
    ? 'message' in payload
    : response.type === 'harness.mcp.error' && typeof payload.error === 'string';
}

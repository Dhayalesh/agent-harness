import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';

type EdgeResponse = {
  version: 1;
  requestId: string;
} & (
  | { type: 'harness.mcp.response' | 'mcp.response'; payload: { message: JSONRPCMessage } }
  | { type: 'harness.mcp.error'; payload: { error: string } }
  | { type: 'edge.error'; payload: { code: string } }
);

const ADT_RELAY_TIMEOUT_MS = 55_000; // The ADT relay expires requests after 60 seconds.
const GUI_RELAY_TIMEOUT_MS = 115_000; // The GUI relay expires requests after 120 seconds.

/** The deployed GUI relay uses /ws; all other routes keep the existing ADT wire format. */
export function usesGuiEdgeProtocol(url: URL): boolean {
  return url.pathname === '/ws';
}

export function edgeRelayTimeoutMs(url: URL): number {
  return usesGuiEdgeProtocol(url) ? GUI_RELAY_TIMEOUT_MS : ADT_RELAY_TIMEOUT_MS;
}

export class EdgeClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private socket?: WebSocket;
  private closed = false;
  private readonly pending = new Map<string, { rpcId: string | number; timer: NodeJS.Timeout }>();
  private readonly notifications = new Map<string, NodeJS.Timeout>();
  private readonly ignoredReplies = new Map<string, NodeJS.Timeout>();
  private readonly guiRelay: boolean;
  private readonly relayTimeoutMs: number;

  constructor(
    private readonly url: URL,
    private readonly mcpId: string,
    private readonly email: string,
    private readonly serverName: string,
    private readonly connectTimeoutMs = ADT_RELAY_TIMEOUT_MS,
    private readonly logSink?: LogSink,
    private readonly logContext: LogContext = {},
  ) {
    this.guiRelay = usesGuiEdgeProtocol(url);
    this.relayTimeoutMs = edgeRelayTimeoutMs(url);
  }

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
        Math.min(this.connectTimeoutMs, this.relayTimeoutMs),
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
    // Both relays lack MCP cancellation. The SDK has already rejected the local
    // request, so release its pending slot and ignore a late relay response.
    if ('method' in message && message.method === 'notifications/cancelled' && !('id' in message)) {
      const params = 'params' in message ? message.params : undefined;
      const cancelledId =
        params && typeof params === 'object' && 'requestId' in params
          ? params.requestId
          : undefined;
      for (const [requestId, pending] of this.pending) {
        if (pending.rpcId !== cancelledId) continue;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        const timer = setTimeout(() => this.ignoredReplies.delete(requestId), this.relayTimeoutMs);
        this.ignoredReplies.set(requestId, timer);
      }
      return;
    }
    const initializedNotification =
      'method' in message && message.method === 'notifications/initialized' && !('id' in message);
    // The ADT connector treats this notification as a no-op. The GUI relay
    // forwards it to the Windows MCP process and sends no response.
    if (initializedNotification && !this.guiRelay) {
      return;
    }
    const rpcId = 'id' in message ? message.id : undefined;
    if (!initializedNotification && typeof rpcId !== 'string' && typeof rpcId !== 'number') {
      throw new Error('Edge transport only supports MCP requests with a JSON-RPC id');
    }
    const requestId = randomUUID();
    if (initializedNotification) {
      const timer = setTimeout(() => this.notifications.delete(requestId), this.relayTimeoutMs);
      this.notifications.set(requestId, timer);
    } else if (typeof rpcId === 'string' || typeof rpcId === 'number') {
      const timer = setTimeout(
        () => this.fail(new Error('Edge MCP request timed out')),
        this.relayTimeoutMs,
      );
      this.pending.set(requestId, { rpcId, timer });
    }
    const envelope = this.guiRelay
      ? {
          version: 1,
          type: 'mcp.request',
          requestId,
          email: this.email,
          payload: { mcpId: this.mcpId, message },
        }
      : {
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
      const timer = this.pending.get(requestId)?.timer ?? this.notifications.get(requestId);
      if (timer) clearTimeout(timer);
      this.pending.delete(requestId);
      this.notifications.delete(requestId);
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
      if (!isEdgeResponse(response, this.guiRelay)) throw new Error('Malformed Edge response');
      const ignoredTimer = this.ignoredReplies.get(response.requestId);
      if (ignoredTimer) {
        clearTimeout(ignoredTimer);
        this.ignoredReplies.delete(response.requestId);
        return;
      }
      const notificationTimer = this.notifications.get(response.requestId);
      if (notificationTimer) {
        clearTimeout(notificationTimer);
        this.notifications.delete(response.requestId);
        throw new Error(
          response.type === 'edge.error'
            ? `GUI Edge notification rejected: ${response.payload.code}`
            : 'Unexpected GUI Edge notification response',
        );
      }
      const pending = this.pending.get(response.requestId);
      if (!pending) throw new Error('Unknown Edge requestId');
      clearTimeout(pending.timer);
      this.pending.delete(response.requestId);
      if (response.type === 'harness.mcp.error' || response.type === 'edge.error') {
        const error =
          response.type === 'edge.error' ? response.payload.code : response.payload.error;
        this.log('edge.mcp.error', {
          edgeRequestId: response.requestId,
          error,
        });
        this.onmessage?.({
          jsonrpc: '2.0',
          id: pending.rpcId,
          error: { code: -32000, message: error },
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
    for (const timer of this.notifications.values()) clearTimeout(timer);
    this.notifications.clear();
    for (const timer of this.ignoredReplies.values()) clearTimeout(timer);
    this.ignoredReplies.clear();
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

function isEdgeResponse(value: unknown, guiRelay: boolean): value is EdgeResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || typeof response.requestId !== 'string' || !response.requestId)
    return false;
  if (!response.payload || typeof response.payload !== 'object') return false;
  const payload = response.payload as Record<string, unknown>;
  if (guiRelay) {
    return response.type === 'mcp.response'
      ? 'message' in payload
      : response.type === 'edge.error' && typeof payload.code === 'string';
  }
  return response.type === 'harness.mcp.response'
    ? 'message' in payload
    : response.type === 'harness.mcp.error' && typeof payload.error === 'string';
}

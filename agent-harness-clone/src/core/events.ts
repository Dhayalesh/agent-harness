import type { AgentMessage, ToolCallBlock, ToolResultBlock } from './messages.js';
import type { ModelUsage, StopReason } from '../models/provider.js';

type EventBase = {
  protocolVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId: string;
};

export type AgentEvent = EventBase &
  (
    | { type: 'session.started' }
    | { type: 'session.completed'; reason: StopReason | 'closed' }
    | { type: 'turn.started'; turnId: string; turn: number }
    | {
        type: 'turn.completed';
        turnId: string;
        turn: number;
        reason: StopReason;
      }
    | { type: 'assistant.text.delta'; turnId: string; delta: string }
    | {
        type: 'assistant.message.completed';
        turnId: string;
        message: AgentMessage;
      }
    | { type: 'tool.requested'; turnId: string; call: ToolCallBlock }
    | { type: 'tool.started'; turnId: string; call: ToolCallBlock }
    | {
        type: 'tool.progress';
        turnId: string;
        toolCallId: string;
        message: string;
        data?: Record<string, unknown>;
      }
    | {
        type: 'tool.completed';
        turnId: string;
        result: ToolResultBlock;
      }
    | {
        type: 'permission.requested';
        turnId: string;
        requestId: string;
        toolCallId: string;
        toolName: string;
        input: unknown;
        description: string;
      }
    | {
        type: 'permission.resolved';
        turnId: string;
        requestId: string;
        decision: 'allow' | 'deny';
      }
    | {
        type: 'context.compaction.started';
        turnId: string;
        estimatedTokens: number;
      }
    | {
        type: 'context.compaction.completed';
        turnId: string;
        tokensBefore: number;
        tokensAfter: number;
      }
    | { type: 'usage.updated'; turnId: string; usage: ModelUsage }
    | { type: 'warning'; code: string; message: string }
    | { type: 'error'; code: string; message: string; recoverable: boolean }
    /**
     * The boundaries below exist so a run is legible from a log alone.
     *
     * The events above describe what the session did once it was built. These
     * describe how it was built and what it talked to — the payload that arrived,
     * the MCP servers that answered, and each model round-trip. Without them a
     * CloudWatch reader can see a tool fail but not the request that caused it.
     */
    | {
        type: 'invocation.received';
        /** Redacted by `redactPayload`; never carries a credential. */
        payload: unknown;
        agentName: string;
        workingDirectory: string;
      }
    | {
        type: 'invocation.completed';
        status: 'success' | 'error';
        durationMs: number;
        turns: number;
        usage: ModelUsage;
      }
    | { type: 'mcp.server.connecting'; server: string; transport: string; target?: string }
    | { type: 'mcp.server.connected'; server: string; durationMs: number }
    | { type: 'mcp.server.failed'; server: string; durationMs: number; message: string }
    | { type: 'mcp.tools.listed'; server: string; tools: readonly string[]; durationMs: number }
    | {
        type: 'mcp.tool.call.started';
        server: string;
        tool: string;
        toolCallId: string;
        input: unknown;
      }
    | {
        type: 'mcp.tool.call.completed';
        server: string;
        tool: string;
        toolCallId: string;
        durationMs: number;
        isError: boolean;
        output?: string;
        message?: string;
      }
    | {
        type: 'model.request.started';
        turnId: string;
        provider: string;
        model?: string;
        messageCount: number;
        toolCount: number;
      }
    | {
        type: 'model.request.completed';
        turnId: string;
        provider: string;
        model?: string;
        durationMs: number;
        stopReason?: StopReason;
        usage?: ModelUsage;
        message?: string;
      }
  );

export type EventPayload = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof EventBase>
    : never
  : never;

export function isSerializableEvent(event: AgentEvent): boolean {
  try {
    const serialized = JSON.stringify(event);
    return JSON.stringify(JSON.parse(serialized)) === serialized;
  } catch {
    return false;
  }
}

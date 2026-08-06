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

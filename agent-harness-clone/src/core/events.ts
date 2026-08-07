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
    /**
     * The model's own deliberation, when it emits any and the provider is
     * configured to forward it. Separate from `assistant.text.delta` because it is
     * not part of the answer: it is shown differently, and a consumer that does not
     * want it can drop one event type rather than filter prose.
     */
    | { type: 'assistant.reasoning.delta'; turnId: string; delta: string }
    /**
     * A tool call arriving argument by argument, before it is complete enough to
     * run. `index` is the correlation key: the id and name are known from the first
     * chunk of a well-behaved provider but are empty strings until they arrive.
     * `tool.requested` still marks the assembled call.
     */
    | {
        type: 'tool.input.delta';
        turnId: string;
        index: number;
        toolCallId: string;
        toolName: string;
        delta: string;
      }
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
    /**
     * Work done before the first turn can start: the workspace, the model, MCP
     * connections, skill documents. Without these a stream is silent for as long as
     * preparation takes, which for a stdio MCP server that has to be installed is
     * the longest silence in the run.
     */
    | {
        type: 'run.preparing';
        stage: 'workspace' | 'agent' | 'mcp' | 'skills' | 'ready';
        message: string;
        data?: Record<string, unknown>;
      }
    | { type: 'warning'; code: string; message: string }
    | { type: 'error'; code: string; message: string; recoverable: boolean }
  );

export type RunPreparationStage = Extract<AgentEvent, { type: 'run.preparing' }>['stage'];

/**
 * How the layers that run before the session report what they are doing.
 *
 * A plain callback rather than a generator because preparation is a call tree,
 * not a stream: the registry connecting an MCP server is several frames below the
 * transport that wants to say so.
 */
export type RunProgressReporter = (
  stage: RunPreparationStage,
  message: string,
  data?: Record<string, unknown>,
) => void;

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

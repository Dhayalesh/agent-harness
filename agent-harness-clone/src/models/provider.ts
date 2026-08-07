import type { AgentMessage } from '../core/messages.js';
import type { ToolDescriptor } from '../tools/tool.js';

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'max_turns'
  | 'cancelled'
  | 'budget_exceeded'
  | 'model_error';

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Counted inside `outputTokens` by every provider that reports both, so this is
   * a breakdown and not an addition. Billed output on a reasoning model is mostly
   * this, which is why it is worth carrying separately.
   */
  reasoningTokens?: number;
  estimatedCostUsd?: number;
};

export type ModelRequest = {
  messages: readonly AgentMessage[];
  systemPrompt?: string;
  model?: string;
  tools: readonly ToolDescriptor[];
  maxOutputTokens?: number;
  signal: AbortSignal;
};

export type ModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  /** Deliberation, where the model emits it separately from its answer. */
  | { type: 'reasoning_delta'; delta: string }
  /**
   * A tool call still being assembled. `index` is the provider's own slot number
   * and the only field guaranteed present from the first chunk.
   */
  | {
      type: 'tool_call_delta';
      index: number;
      id: string;
      name: string;
      argumentsDelta: string;
    }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: ModelUsage }
  /**
   * Something the caller should see that did not stop the turn — a retried
   * request, a rate limit waited out. A provider that swallows these leaves the
   * stream looking stalled.
   */
  | { type: 'warning'; code: string; message: string }
  | { type: 'completed'; stopReason: StopReason };

export interface ModelProvider {
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

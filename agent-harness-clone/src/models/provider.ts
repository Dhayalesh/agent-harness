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
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'completed'; stopReason: StopReason };

export interface ModelProvider {
  readonly name: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}

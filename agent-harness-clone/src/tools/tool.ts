import type { z } from 'zod';
import type { AgentMessage } from '../core/messages.js';

export type ToolKind = 'read' | 'write' | 'execute' | 'network' | 'interactive';

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolExecutionContext = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  workingDirectory: string;
  signal: AbortSignal;
  messages: readonly AgentMessage[];
  reportProgress(message: string, data?: Record<string, unknown>): void;
};

export type ToolExecutionResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

export interface Tool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly jsonSchema: Record<string, unknown>;
  readonly kind: ToolKind;
  readonly concurrencySafe: boolean;
  readonly destructive?: boolean;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

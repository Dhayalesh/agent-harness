import type { z } from 'zod';
import type { AgentMessage } from '../core/messages.js';

export type ToolKind = 'read' | 'write' | 'execute' | 'network' | 'interactive';

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Mirrors `PermissionDecision` without importing from `../permissions`, which
 * would create a cycle (the permission layer depends on tools).
 */
export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Per-invocation permission verdict produced by a tool.
 *
 * `kind` classifies a tool as a whole; this classifies a single set of inputs.
 * `bash` is the motivating case: `git status` and `rm -rf /` share a tool but
 * not a risk profile.
 */
export type ToolPermissionCheck = {
  decision: ToolPermissionDecision;
  /** Why this decision was reached. Surfaced to the user and in denials. */
  reason?: string;
  /**
   * Informational note shown alongside an approval prompt. Never changes the
   * decision on its own.
   */
  warning?: string;
};

export type ToolPermissionCheckContext = {
  sessionId: string;
  workingDirectory: string;
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
  /**
   * A transport can return a fulfilled promise that still represents a tool
   * failure (MCP's `isError` response is the common case).
   */
  isError?: boolean;
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
  /**
   * Optional per-invocation permission check, evaluated after input validation
   * and before the session's `PermissionHandler`. A `deny` here is absolute:
   * no rule, mode, or handler can override it.
   */
  checkPermissions?(
    input: Input,
    context: ToolPermissionCheckContext,
  ): ToolPermissionCheck | Promise<ToolPermissionCheck>;
  execute(input: Input, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

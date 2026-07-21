import type { AgentEvent } from '../core/events.js';

export type JsonlCommand =
  | { type: 'run'; prompt: string }
  | { type: 'permission'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt'; reason?: string }
  | { type: 'close' };

export function serializeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseCommand(line: string): JsonlCommand {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('JSONL command must be an object with a type');
  }
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case 'run':
      if (typeof command.prompt !== 'string') throw new Error('run.prompt must be a string');
      return { type: 'run', prompt: command.prompt };
    case 'permission':
      if (
        typeof command.requestId !== 'string' ||
        (command.decision !== 'allow' && command.decision !== 'deny')
      ) {
        throw new Error('permission command is invalid');
      }
      return {
        type: 'permission',
        requestId: command.requestId,
        decision: command.decision,
      };
    case 'interrupt':
      return {
        type: 'interrupt',
        ...(typeof command.reason === 'string' ? { reason: command.reason } : {}),
      };
    case 'close':
      return { type: 'close' };
    default:
      throw new Error(`Unknown JSONL command: ${String(command.type)}`);
  }
}

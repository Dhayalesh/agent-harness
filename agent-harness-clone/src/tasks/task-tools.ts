import { z } from 'zod';
import type { Tool } from '../tools/tool.js';
import type { TaskManager } from './task-manager.js';

export function createTaskTools(manager: TaskManager): Tool[] {
  const startShellSchema = z.object({
    command: z.string().min(1),
    description: z.string().optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  });
  const startAgentSchema = z.object({
    prompt: z.string().min(1),
    description: z.string().optional(),
  });
  const idSchema = z.object({ id: z.string().uuid() });

  const startShellTool: Tool<z.infer<typeof startShellSchema>> = {
    name: 'task_start_shell',
    description: 'Start a shell command as a background task',
    inputSchema: startShellSchema,
    jsonSchema: objectSchema(
      { command: { type: 'string' }, description: { type: 'string' }, cwd: { type: 'string' } },
      ['command'],
    ),
    kind: 'execute',
    concurrencySafe: false,
    async execute(input, context) {
      const task = manager.startShell({
        command: input.command,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        parentSessionId: context.sessionId,
        parentToolCallId: context.toolCallId,
      });
      return { content: JSON.stringify(task), metadata: { taskId: task.id } };
    },
  };
  const startAgentTool: Tool<z.infer<typeof startAgentSchema>> = {
    name: 'task_start_agent',
    description: 'Start a scoped background subagent',
    inputSchema: startAgentSchema,
    jsonSchema: objectSchema({ prompt: { type: 'string' }, description: { type: 'string' } }, [
      'prompt',
    ]),
    kind: 'execute',
    concurrencySafe: false,
    async execute(input, context) {
      const task = manager.startAgent({
        prompt: input.prompt,
        ...(input.description === undefined ? {} : { description: input.description }),
        parentSessionId: context.sessionId,
        parentToolCallId: context.toolCallId,
      });
      return { content: JSON.stringify(task), metadata: { taskId: task.id } };
    },
  };
  const getTool: Tool<z.infer<typeof idSchema>> = {
    name: 'task_get',
    description: 'Get current output and status for a background task',
    inputSchema: idSchema,
    jsonSchema: objectSchema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    kind: 'read',
    concurrencySafe: true,
    async execute({ id }) {
      const task = manager.get(id);
      if (!task) throw new Error(`Unknown task: ${id}`);
      return { content: JSON.stringify(task), metadata: { taskId: id } };
    },
  };
  const stopTool: Tool<z.infer<typeof idSchema>> = {
    name: 'task_stop',
    description: 'Stop a running background task',
    inputSchema: idSchema,
    jsonSchema: objectSchema({ id: { type: 'string', format: 'uuid' } }, ['id']),
    kind: 'execute',
    concurrencySafe: false,
    async execute({ id }) {
      return { content: manager.stop(id) ? `Stopped ${id}` : `Task ${id} was not running` };
    },
  };
  return [startShellTool, startAgentTool, getTool, stopTool];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

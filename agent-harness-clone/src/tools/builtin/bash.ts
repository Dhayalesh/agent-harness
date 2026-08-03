import { z } from 'zod';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import { evaluateShellCommand } from '../shell/index.js';
import type { Tool, ToolPermissionCheck } from '../tool.js';

const schema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export type BashToolOptions = {
  /**
   * Auto-approve commands classified as read-only. Mirrors claude-code's
   * read-only fast path. Set to `false` to prompt for every command.
   */
  autoApproveReadOnly?: boolean;
};

export function createBashTool(
  runtime: RuntimeHost,
  options: BashToolOptions = {},
): Tool<z.infer<typeof schema>> {
  return {
    name: 'bash',
    description: 'Execute a shell command inside the workspace',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    kind: 'execute',
    concurrencySafe: false,
    destructive: true,
    checkPermissions(input, context): ToolPermissionCheck {
      return evaluateShellCommand(input.command, 'bash', {
        workspaceRoot: runtime.rootDirectory,
        cwd: input.cwd === undefined ? context.workingDirectory : input.cwd,
        ...(options.autoApproveReadOnly === undefined
          ? {}
          : { autoApproveReadOnly: options.autoApproveReadOnly }),
      });
    },
    async execute(input, context) {
      const result = await runtime.execute(input.command, {
        signal: context.signal,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        onOutput(stream, chunk) {
          context.reportProgress(`${stream}: ${chunk.slice(0, 500)}`);
        },
      });
      const combined = [
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
        `exit_code: ${String(result.exitCode)}`,
        result.signal && `signal: ${result.signal}`,
        result.timedOut && 'timed_out: true',
        result.truncated && 'output_truncated: true',
      ]
        .filter(Boolean)
        .join('\n');
      return { content: combined, metadata: result };
    },
  };
}

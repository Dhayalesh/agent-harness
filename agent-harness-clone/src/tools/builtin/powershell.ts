import { z } from 'zod';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import { evaluateShellCommand } from '../shell/index.js';
import type { Tool, ToolPermissionCheck } from '../tool.js';

/**
 * Ported from `claude-code/src/tools/PowerShellTool/PowerShellTool.tsx`.
 *
 * Kept as a separate tool rather than a `shell` parameter on `bash` for the same
 * reason claude-code splits them: the security layers are not interchangeable,
 * and permission rules need to distinguish `bash(...)` from `powershell(...)`.
 */

const schema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

export type PowerShellToolOptions = {
  /**
   * Executable used to run the command. Defaults to `pwsh` when available at
   * call time is not detectable here, so the default is `powershell` on Windows
   * and `pwsh` elsewhere.
   */
  executable?: string;
  autoApproveReadOnly?: boolean;
};

/** True when a PowerShell host is plausibly available. */
export function isPowerShellAvailable(): boolean {
  return process.platform === 'win32' || process.env.AGENT_HARNESS_ENABLE_PWSH === '1';
}

export function createPowerShellTool(
  runtime: RuntimeHost,
  options: PowerShellToolOptions = {},
): Tool<z.infer<typeof schema>> {
  const executable = options.executable ?? (process.platform === 'win32' ? 'powershell' : 'pwsh');

  return {
    name: 'powershell',
    description:
      'Execute a PowerShell command inside the workspace. Prefer this over bash on Windows hosts.',
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
      return evaluateShellCommand(input.command, 'powershell', {
        workspaceRoot: runtime.rootDirectory,
        cwd: input.cwd === undefined ? context.workingDirectory : input.cwd,
        ...(options.autoApproveReadOnly === undefined
          ? {}
          : { autoApproveReadOnly: options.autoApproveReadOnly }),
      });
    },
    async execute(input, context) {
      // -NoProfile keeps user profile scripts out of the session; -NonInteractive
      // makes a prompt-waiting command fail fast instead of hanging the turn.
      const wrapped = `${executable} -NoProfile -NonInteractive -Command ${quoteForShell(input.command)}`;
      const result = await runtime.execute(wrapped, {
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
      return { content: combined, metadata: { ...result, executable } };
    },
  };
}

/**
 * Quotes a command for the outer shell. `RuntimeHost.execute` uses `shell: true`,
 * so the string is interpreted by cmd.exe or /bin/sh before PowerShell sees it.
 * Double quotes are the only form cmd.exe understands, and `"` inside must be
 * doubled for PowerShell's own parser.
 */
function quoteForShell(command: string): string {
  return `"${command.replace(/"/g, '""')}"`;
}

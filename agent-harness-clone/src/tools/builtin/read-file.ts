import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';
import type { FileSnapshotStore } from './file-snapshots.js';

const schema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
});

export function createReadFileTool(
  runtime: RuntimeHost,
  snapshots: FileSnapshotStore,
  maxBytes = 1_000_000,
): Tool<z.infer<typeof schema>> {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace, optionally by line range',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 10_000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      const resolved = await runtime.resolvePath(input.path);
      const fileStat = await runtime.stat(resolved);
      if (!fileStat.isFile) {
        throw new AgentHarnessError(`${input.path} is not a file`, 'NOT_A_FILE');
      }
      if (fileStat.size > maxBytes) {
        throw new AgentHarnessError(
          `File exceeds ${maxBytes} byte read limit; use a more targeted tool`,
          'FILE_TOO_LARGE',
        );
      }
      const content = await runtime.readText(resolved);
      snapshots.set(resolved, { content, modifiedAtMs: fileStat.modifiedAtMs });
      const lines = content.split(/\r?\n/);
      const offset = input.offset ?? 0;
      const selected = lines.slice(
        offset,
        input.limit === undefined ? undefined : offset + input.limit,
      );
      const numbered = selected.map((line, index) => `${offset + index + 1}\t${line}`).join('\n');
      return {
        content: numbered,
        metadata: {
          path: resolved,
          source: {
            id: `file:${resolved}`,
            name: input.path,
            type: 'document',
            provider: 'workspace',
            authority: 0.9,
            uri: resolved,
          },
          totalLines: lines.length,
          offset,
          returnedLines: selected.length,
        },
      };
    },
  };
}

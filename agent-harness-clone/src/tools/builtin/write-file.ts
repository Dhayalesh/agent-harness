import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';
import type { FileSnapshotStore } from './file-snapshots.js';

const schema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export function createWriteFileTool(
  runtime: RuntimeHost,
  snapshots: FileSnapshotStore,
): Tool<z.infer<typeof schema>> {
  return {
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file inside the workspace',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: false,
    destructive: true,
    async execute(input) {
      const resolved = await runtime.resolvePath(input.path, true);
      try {
        const current = await runtime.stat(resolved);
        const snapshot = snapshots.get(resolved);
        if (!snapshot) {
          throw new AgentHarnessError(
            'Existing files must be read before they are overwritten',
            'READ_BEFORE_WRITE',
          );
        }
        if (current.modifiedAtMs > snapshot.modifiedAtMs) {
          throw new AgentHarnessError(
            'File changed after it was read; read it again before writing',
            'FILE_CHANGED',
          );
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
      await runtime.writeText(resolved, input.content);
      const updated = await runtime.stat(resolved);
      snapshots.set(resolved, {
        content: input.content,
        modifiedAtMs: updated.modifiedAtMs,
      });
      return {
        content: `Wrote ${Buffer.byteLength(input.content)} bytes to ${resolved}`,
        metadata: { path: resolved, bytes: Buffer.byteLength(input.content) },
      };
    },
  };
}

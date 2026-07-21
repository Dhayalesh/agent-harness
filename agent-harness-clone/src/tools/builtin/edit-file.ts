import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';
import type { FileSnapshotStore } from './file-snapshots.js';

const schema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});

export function createEditFileTool(
  runtime: RuntimeHost,
  snapshots: FileSnapshotStore,
): Tool<z.infer<typeof schema>> {
  return {
    name: 'edit_file',
    description: 'Replace an exact string in a previously read workspace file',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: false,
    async execute(input) {
      if (input.oldText === input.newText) {
        throw new AgentHarnessError('Edit would not change the file', 'NO_OP_EDIT');
      }
      const resolved = await runtime.resolvePath(input.path);
      const snapshot = snapshots.get(resolved);
      if (!snapshot) {
        throw new AgentHarnessError('File must be read before it is edited', 'READ_BEFORE_EDIT');
      }
      const fileStat = await runtime.stat(resolved);
      if (fileStat.modifiedAtMs > snapshot.modifiedAtMs) {
        throw new AgentHarnessError(
          'File changed after it was read; read it again before editing',
          'FILE_CHANGED',
        );
      }
      const current = await runtime.readText(resolved);
      const occurrences = countOccurrences(current, input.oldText);
      if (occurrences === 0) {
        throw new AgentHarnessError('oldText was not found in the file', 'TEXT_NOT_FOUND');
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new AgentHarnessError(
          `oldText occurs ${occurrences} times; provide more context or set replaceAll`,
          'AMBIGUOUS_EDIT',
        );
      }
      const updated = input.replaceAll
        ? current.replaceAll(input.oldText, input.newText)
        : current.replace(input.oldText, input.newText);
      await runtime.writeText(resolved, updated);
      const updatedStat = await runtime.stat(resolved);
      snapshots.set(resolved, { content: updated, modifiedAtMs: updatedStat.modifiedAtMs });
      return {
        content: `Edited ${resolved}; replaced ${input.replaceAll ? occurrences : 1} occurrence(s)`,
        metadata: { path: resolved, replacements: input.replaceAll ? occurrences : 1 },
      };
    },
  };
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 1;
  let count = 0;
  let cursor = 0;
  while ((cursor = content.indexOf(search, cursor)) !== -1) {
    count += 1;
    cursor += search.length;
  }
  return count;
}

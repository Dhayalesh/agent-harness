import path from 'node:path';
import { z } from 'zod';
import { AgentHarnessError } from '../../core/errors.js';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';

const schema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().max(10_000).optional(),
});

export function createGrepTool(runtime: RuntimeHost): Tool<z.infer<typeof schema>> {
  return {
    name: 'grep',
    description: 'Search UTF-8 workspace files for a text or regular-expression pattern',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'integer', minimum: 1, maximum: 10_000 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      let matcher: RegExp;
      try {
        matcher = new RegExp(input.query, input.caseSensitive ? 'g' : 'gi');
      } catch (cause) {
        throw new AgentHarnessError('Invalid regular expression', 'INVALID_REGEX', false, {
          cause,
        });
      }
      const start = await runtime.resolvePath(input.path ?? '.');
      const maxResults = input.maxResults ?? 1_000;
      const results: string[] = [];
      await search(runtime, start, start, matcher, results, maxResults);
      return {
        content: results.length === 0 ? 'No matches found' : results.join('\n'),
        metadata: { count: results.length, truncated: results.length >= maxResults },
      };
    },
  };
}

async function search(
  runtime: RuntimeHost,
  root: string,
  current: string,
  matcher: RegExp,
  results: string[],
  limit: number,
): Promise<void> {
  const currentStat = await runtime.stat(current);
  if (currentStat.isFile) {
    if (currentStat.size > 1_000_000) return;
    let content: string;
    try {
      content = await runtime.readText(current);
    } catch {
      return;
    }
    const relative = path.relative(root, current) || path.basename(current);
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      matcher.lastIndex = 0;
      if (matcher.test(line)) results.push(`${relative}:${index + 1}:${line}`);
      if (results.length >= limit) return;
    }
    return;
  }
  for (const entry of await runtime.readDirectory(current)) {
    if (results.length >= limit) return;
    if (entry.isSymbolicLink) continue;
    if (entry.isDirectory && (entry.name === '.git' || entry.name === 'node_modules')) continue;
    await search(runtime, root, path.join(current, entry.name), matcher, results, limit);
  }
}

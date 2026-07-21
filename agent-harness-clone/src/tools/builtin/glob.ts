import path from 'node:path';
import { z } from 'zod';
import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';

const schema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(10_000).optional(),
});

export function createGlobTool(runtime: RuntimeHost): Tool<z.infer<typeof schema>> {
  return {
    name: 'glob',
    description: 'Find files by a workspace-relative glob pattern',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        maxResults: { type: 'integer', minimum: 1, maximum: 10_000 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      const start = await runtime.resolvePath(input.path ?? '.');
      const matcher = globToRegExp(input.pattern.replaceAll('\\', '/'));
      const maxResults = input.maxResults ?? 1_000;
      const results: string[] = [];
      await walk(runtime, start, start, matcher, results, maxResults);
      return {
        content: results.length === 0 ? 'No files matched' : results.join('\n'),
        metadata: { count: results.length, truncated: results.length >= maxResults },
      };
    },
  };
}

async function walk(
  runtime: RuntimeHost,
  root: string,
  directory: string,
  matcher: RegExp,
  results: string[],
  limit: number,
): Promise<void> {
  if (results.length >= limit) return;
  const entries = await runtime.readDirectory(directory);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (results.length >= limit) return;
    if (entry.isSymbolicLink) continue;
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(root, fullPath).split(path.sep).join('/');
    if (entry.isFile && matcher.test(relative)) results.push(relative);
    if (entry.isDirectory && entry.name !== 'node_modules' && entry.name !== '.git') {
      await walk(runtime, root, fullPath, matcher, results, limit);
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let result = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      if (pattern[index + 2] === '/') {
        result += '(?:.*/)?';
        index += 2;
      } else {
        result += '.*';
        index += 1;
      }
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
  }
  return new RegExp(`${result}$`);
}

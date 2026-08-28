import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const schema = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  content: z.string().min(1).max(2_000_000),
  format: z.enum(['json', 'ndjson']).default('json'),
});

/**
 * A response-presentation tool for structured data.
 *
 * Both formats are parsed before they are stored. A JSON file that does not parse
 * is worthless to whoever downloads it, and the model is the only party still able
 * to fix it — so a parse failure comes back as a tool error naming the offending
 * position rather than a broken file the user discovers later.
 */
export function createJsonArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_json_artifact',
    description:
      'Present structured data to the user as a downloadable .json or .ndjson file. Use this when ' +
      'the requested format is JSON or NDJSON — including a config file, API payload, export, schema, ' +
      'data template, or newline-delimited dataset. The content is validated before it is saved. Do ' +
      'not use it to show a short JSON snippet inside a conversational answer.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable title for the data' },
        filename: {
          type: 'string',
          description:
            'Safe download filename ending in .json or .ndjson, without a directory path',
        },
        content: {
          type: 'string',
          description:
            'The complete document. For json, one JSON value. For ndjson, one JSON value per line.',
        },
        format: {
          type: 'string',
          enum: ['json', 'ndjson'],
          description: 'Defaults to json. Use ndjson for one independent record per line.',
        },
      },
      required: ['title', 'filename', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    // Writes only to the harness-owned response store, never the workspace.
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const normalized =
        input.format === 'ndjson' ? normalizeNdjson(input.content) : normalizeJson(input.content);
      if ('error' in normalized) {
        return { content: normalized.error, isError: true };
      }
      const descriptor = artifactDescriptor(input.format, input.title, input.filename, context);
      const artifact = await store.put(normalized.text, {
        contentType: descriptor.contentType,
        metadata: { ...descriptor.metadata, records: normalized.records },
      });
      return {
        content:
          `Created ${input.format === 'ndjson' ? 'NDJSON dataset' : 'JSON document'} ` +
          `${descriptor.filename}` +
          (input.format === 'ndjson' ? ` with ${normalized.records} records` : ''),
        metadata: { artifact },
      };
    },
  };
}

type Normalized = { text: string; records: number } | { error: string };

/** Reformats to two-space indentation, which is what makes the download readable. */
function normalizeJson(content: string): Normalized {
  try {
    return { text: `${JSON.stringify(JSON.parse(content), null, 2)}\n`, records: 1 };
  } catch (error) {
    return { error: `Content is not valid JSON: ${describe(error)}` };
  }
}

/**
 * One compact value per line.
 *
 * Blank lines are dropped rather than rejected, because a model that ends its last
 * record with a newline has not made a mistake. A non-object value is allowed: the
 * format is newline-delimited JSON, not newline-delimited objects.
 */
function normalizeNdjson(content: string): Normalized {
  const lines = content.split(/\r?\n/);
  const records: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.stringify(JSON.parse(line)));
    } catch (error) {
      return { error: `Line ${index + 1} is not valid JSON: ${describe(error)}` };
    }
  }
  if (!records.length) return { error: 'Content contains no JSON records' };
  return { text: `${records.join('\n')}\n`, records: records.length };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

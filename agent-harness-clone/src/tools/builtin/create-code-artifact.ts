import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import { CODE_LANGUAGE_NAMES, CODE_LANGUAGES } from '../../artifacts/artifact-formats.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const schema = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  language: z.enum(CODE_LANGUAGE_NAMES),
  content: z.string().min(1).max(2_000_000),
});

/**
 * A response-presentation tool for source files.
 *
 * Distinct from `write_file`, and the distinction is the point: `write_file` puts a
 * file in the workspace for a later tool to compile or run, while this hands the
 * user a file to keep. A coding task that builds and tests something uses the
 * former; "write me a Go client for this API" uses this one.
 *
 * The language chooses the extension. The stored content type stays `text/plain`
 * for every language, so nothing downstream is tempted to render or execute it.
 */
export function createCodeArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_code_artifact',
    description:
      'Present a complete source file to the user as a downloadable code file. Use this when the ' +
      'requested format is source code the user will keep — a script, module, class, config, query, ' +
      'manifest, or reusable code template. Supported languages: ' +
      CODE_LANGUAGE_NAMES.join(', ') +
      '. Use write_file instead when the file only needs to exist in the workspace for a later ' +
      'build or test step, and do not use this for short snippets inside a conversational answer.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable title for the file' },
        filename: {
          type: 'string',
          description:
            "Safe download filename without a directory path. The language's extension is " +
            'appended when it is missing.',
        },
        language: {
          type: 'string',
          enum: [...CODE_LANGUAGE_NAMES],
          description: 'Language of the file, which selects its extension',
        },
        content: { type: 'string', description: 'The complete source file' },
      },
      required: ['title', 'filename', 'language', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    // Writes only to the harness-owned response store, never the workspace.
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const descriptor = artifactDescriptor('code', input.title, input.filename, context, {
        language: input.language,
      });
      const artifact = await store.put(input.content, {
        contentType: descriptor.contentType,
        metadata: descriptor.metadata,
      });
      return {
        content: `Created ${CODE_LANGUAGES[input.language].label} file ${descriptor.filename}`,
        metadata: { artifact },
      };
    },
  };
}

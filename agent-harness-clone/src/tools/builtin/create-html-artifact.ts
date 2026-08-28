import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const schema = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  content: z.string().max(2_000_000),
});

export function createHtmlArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_html_artifact',
    description:
      'Present a completed HTML deliverable as a downloadable .html file with a sandboxed preview. ' +
      'Use only when the requested format is HTML, such as a web page, HTML report, HTML template, ' +
      'or reusable HTML document. The word “template” alone does not imply HTML; honor the requested ' +
      'format or filename extension. Do not use it for ordinary conversational answers.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable artifact title' },
        filename: { type: 'string', description: 'Download filename ending in .html' },
        content: { type: 'string', description: 'Complete HTML source' },
      },
      required: ['title', 'filename', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const descriptor = artifactDescriptor('html', input.title, input.filename, context);
      const artifact = await store.put(input.content, descriptor);
      return {
        content: `Created HTML document ${descriptor.filename}`,
        metadata: { artifact },
      };
    },
  };
}

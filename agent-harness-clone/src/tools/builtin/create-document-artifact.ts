import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import { buildDocx } from '../../artifacts/builders/docx-builder.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const schema = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  content: z.string().max(2_000_000),
});

export function createDocumentArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_document_artifact',
    description:
      'Create a downloadable Microsoft Word .docx document from complete Markdown-like source. ' +
      'Use when the user asks for a Word document, editable office document, formal report, or specification.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable document title' },
        filename: { type: 'string', description: 'Download filename ending in .docx' },
        content: {
          type: 'string',
          description:
            'Complete Markdown-like source; headings, lists and tables are converted to Word',
        },
      },
      required: ['title', 'filename', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const descriptor = artifactDescriptor('docx', input.title, input.filename, context);
      const bytes = await buildDocx(input.title, input.content);
      const artifact = await store.put(bytes, descriptor);
      return {
        content: `Created Word document ${descriptor.filename}`,
        metadata: { artifact },
      };
    },
  };
}

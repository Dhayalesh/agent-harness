import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { Tool } from '../tool.js';

const schema = z.object({
  title: z.string().min(1).max(200),
  filename: z.string().min(1).max(200),
  content: z.string().max(2_000_000),
});

/**
 * A response-presentation tool, rather than a workspace file tool.
 *
 * The model chooses this tool when the user's requested deliverable is a Markdown
 * document. That choice is the intent signal consumed by the transport: callers do
 * not have to guess from words such as "doc" or from whether an unrelated coding
 * task happened to edit a .md file.
 */
export function createMarkdownArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_markdown_artifact',
    description:
      'Present a completed Markdown document to the user as a downloadable .md file. Use this ' +
      'when the requested deliverable is a document, report, proposal, specification, guide, ' +
      'README, or other reusable Markdown file. Do not use it for ordinary conversational answers.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable document title' },
        filename: {
          type: 'string',
          description: 'Safe download filename ending in .md, without a directory path',
        },
        content: { type: 'string', description: 'The complete Markdown document' },
      },
      required: ['title', 'filename', 'content'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    // This writes only to the harness-owned response store. It cannot change the
    // workspace or an external system, so plan/default modes may safely allow it.
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const filename = markdownFilename(input.filename);
      const artifact = await store.put(input.content, {
        contentType: 'text/markdown; charset=utf-8',
        metadata: {
          kind: 'markdown',
          title: input.title,
          filename,
          presentation: 'file',
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
        },
      });
      return {
        content: `Created Markdown document ${filename}`,
        metadata: { artifact },
      };
    },
  };
}

function markdownFilename(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim() || 'document.md';
  const safe = leaf
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 196);
  const base = safe && safe !== '.' && safe !== '..' ? safe : 'document';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

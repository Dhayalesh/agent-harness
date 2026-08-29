import { z } from 'zod';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { Tool } from '../tools/tool.js';

const inputSchema = z
  .object({
    artifactId: z.string().min(1).max(300),
    offset: z.number().int().nonnegative().default(0),
    maxChars: z.number().int().positive().max(50_000).default(12_000),
  })
  .strict();

/**
 * Read-only drill-down for details Context Intelligence offloaded through the
 * existing ArtifactStore. Execution, validation, permissions, and telemetry are
 * still provided by AgentSession like every other local tool.
 */
export function createContextArtifactReadTool(store: ArtifactStore): Tool<z.output<typeof inputSchema>> {
  return {
    name: 'context_artifact_read',
    description:
      'Read a bounded slice of an artifact referenced by curated context. Use only when the active summary is insufficient; supply the artifact id and optional character offset.',
    kind: 'read',
    concurrencySafe: true,
    inputSchema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactId: { type: 'string', minLength: 1, maxLength: 300 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        maxChars: { type: 'integer', minimum: 1, maximum: 50_000, default: 12_000 },
      },
      required: ['artifactId'],
    },
    contextMetadata: {
      id: 'tool:context_artifact_read',
      name: 'context_artifact_read',
      description: 'Drill down into a large context artifact by stable handle.',
      kind: 'read',
      keywords: ['artifact', 'details', 'drill-down', 'offloaded', 'context'],
      entityTypes: ['artifact'],
      operations: ['read', 'retrieve', 'drill-down'],
      sourceIds: ['artifact-store'],
      authority: 0.9,
      cost: 0.1,
      latency: 0.1,
      preconditions: ['artifactId'],
      effects: ['reads a bounded artifact slice'],
      limitations: ['maximum 50,000 characters per call'],
      policyLabels: ['read'],
      enabled: true,
    },
    async execute(input) {
      const value = await store.get(input.artifactId);
      if (value === undefined) {
        return { content: `Artifact not found: ${input.artifactId}`, isError: true };
      }
      const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
      const content = text.slice(input.offset, input.offset + input.maxChars);
      return {
        content,
        metadata: {
          source: {
            id: `artifact:${input.artifactId}`,
            name: `Artifact ${input.artifactId}`,
            type: 'tool',
            authority: 0.9,
          },
          artifactId: input.artifactId,
          offset: input.offset,
          returnedChars: content.length,
          totalChars: text.length,
          hasMore: input.offset + content.length < text.length,
        },
      };
    },
  };
}

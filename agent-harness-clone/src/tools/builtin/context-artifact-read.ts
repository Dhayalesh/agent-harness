import { z } from 'zod';
import type { Artifact, ArtifactStore } from '../../artifacts/artifact-store.js';
import { AgentHarnessError } from '../../core/errors.js';
import type {
  Tool,
  ToolExecutionContext,
  ToolPermissionCheck,
  ToolPermissionCheckContext,
} from '../tool.js';

const MAX_RETURNED_CHARS = 100_000;
const DEFAULT_RETURNED_CHARS = 50_000;

const schema = z.object({
  artifactId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  referenceOrigin: z.enum(['context_offload', 'explicit_user_reference']).optional(),
  offset: z.number().int().nonnegative().optional(),
  limitChars: z.number().int().positive().max(MAX_RETURNED_CHARS).optional(),
});

type ContextArtifactReadInput = z.infer<typeof schema>;

/**
 * Recalls a bounded range from a Context Intelligence offload through the normal
 * tool validation, permission, execution, and observation path. The intelligence
 * layer plans this operation but never reads the ArtifactStore itself.
 */
export function createContextArtifactReadTool(
  store: ArtifactStore,
  maxArtifactBytes = 10_000_000,
): Tool<ContextArtifactReadInput> {
  const maximumBytes = Math.max(1, maxArtifactBytes);
  return {
    name: 'context_artifact_read',
    description:
      'Read a bounded text range from a same-session artifact created by Context Intelligence offloading. ' +
      'Use the artifact ID from an artifact:// reference; this cannot read unrelated response artifacts.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]+$',
          minLength: 1,
          maxLength: 200,
          description: 'Artifact ID from a validated artifact:// context-offload reference',
        },
        referenceOrigin: {
          type: 'string',
          enum: ['context_offload', 'explicit_user_reference'],
          description: 'Provenance of the artifact reference',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based character offset for bounded drill-down',
        },
        limitChars: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RETURNED_CHARS,
          description: 'Maximum characters to return',
        },
      },
      required: ['artifactId'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async checkPermissions(input, context) {
      return permissionFor(store, input.artifactId, context, maximumBytes);
    },
    async execute(input, context) {
      const artifact = await accessibleArtifact(
        store,
        input.artifactId,
        context,
        maximumBytes,
      );
      const stored = await store.get(input.artifactId);
      if (stored === undefined) {
        throw new AgentHarnessError('Context artifact is unavailable', 'ARTIFACT_NOT_FOUND');
      }
      if (!isTextArtifact(artifact, stored)) {
        throw new AgentHarnessError(
          'Context artifact is not a supported text format',
          'ARTIFACT_CONTENT_UNSUPPORTED',
        );
      }
      const text = typeof stored === 'string' ? stored : Buffer.from(stored).toString('utf8');
      const offset = Math.min(input.offset ?? 0, text.length);
      const limit = input.limitChars ?? DEFAULT_RETURNED_CHARS;
      const content = text.slice(offset, offset + limit);
      const nextOffset = offset + content.length;
      const hasMore = nextOffset < text.length;
      return {
        content,
        metadata: {
          artifactId: artifact.id,
          contentType: artifact.contentType,
          totalChars: text.length,
          offset,
          returnedChars: content.length,
          hasMore,
          ...(hasMore ? { nextOffset } : {}),
          source: {
            id: `artifact:${artifact.id}`,
            name: `artifact://${artifact.id}`,
            type: 'artifact',
            sourceKind: 'ARTIFACT',
            provider: 'artifact-store',
            authority: 0.85,
            sourceTimestamp: artifact.createdAt,
            uri: `artifact://${artifact.id}`,
            evidenceIdentity: `artifact:${artifact.id}:${offset}:${content.length}`,
            policyLabels: ['same-session', 'context-offload'],
          },
        },
      };
    },
  };
}

async function permissionFor(
  store: ArtifactStore,
  artifactId: string,
  context: ToolPermissionCheckContext,
  maxArtifactBytes: number,
): Promise<ToolPermissionCheck> {
  try {
    await accessibleArtifact(store, artifactId, context, maxArtifactBytes);
    return { decision: 'allow' };
  } catch {
    return {
      decision: 'deny',
      reason: 'Artifact recall is limited to bounded Context Intelligence offloads owned by this session.',
    };
  }
}

async function accessibleArtifact(
  store: ArtifactStore,
  artifactId: string,
  context: ToolPermissionCheckContext | ToolExecutionContext,
  maxArtifactBytes: number,
): Promise<Artifact> {
  const artifact = await store.describe(artifactId);
  if (
    artifact === undefined ||
    artifact.metadata.sessionId !== context.sessionId ||
    artifact.metadata.purpose !== 'context-intelligence-offload'
  ) {
    throw new AgentHarnessError('Context artifact access denied', 'ARTIFACT_ACCESS_DENIED');
  }
  if (artifact.size > maxArtifactBytes) {
    throw new AgentHarnessError(
      `Context artifact exceeds the ${maxArtifactBytes} byte recall limit`,
      'ARTIFACT_TOO_LARGE',
    );
  }
  return artifact;
}

function isTextArtifact(artifact: Artifact, content: string | Uint8Array): boolean {
  if (typeof content === 'string') return true;
  return (
    artifact.contentType.startsWith('text/') ||
    /(?:json|xml|javascript|yaml|toml|csv|markdown)/i.test(artifact.contentType)
  );
}

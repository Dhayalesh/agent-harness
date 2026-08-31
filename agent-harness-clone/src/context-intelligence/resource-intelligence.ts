import type { AgentMessage } from '../core/messages.js';
import type {
  ContextNeed,
  ContextRuntimeAction,
  ExecutionState,
  OffloadedArtifact,
  ResourceCandidate,
  ResourceRecord,
  ResourceState,
  RuntimeRetrievalOperation,
  ToolObservation,
} from './contracts.js';
import { dedupeStrings, now, stableHash } from './utils.js';

/**
 * Builds explicit stored-resource state from same-session metadata and executed
 * discovery/retrieval operations. It never probes a store or filesystem itself.
 */
export class ResourceIntelligence {
  assess(input: {
    requestId: string;
    needs: readonly ContextNeed[];
    messages: readonly AgentMessage[];
    offloadedArtifacts: readonly OffloadedArtifact[];
    operations: readonly RuntimeRetrievalOperation[];
  }): ResourceRecord[] {
    const passive = passiveArtifactCandidates(input.messages, input.offloadedArtifacts);
    return input.needs.flatMap((need) => {
      const reference = resourceReference(need);
      if (!reference) return [];
      return need.sourceKinds.flatMap((sourceKind) => {
        if (sourceKind !== 'FILE' && sourceKind !== 'ARTIFACT') return [];
        const operations = input.operations.filter(
          (operation) =>
            operation.requestId === input.requestId &&
            operation.needId === need.id &&
            capabilitySourceKind(operation.capability) === sourceKind,
        );
        const passiveMatches =
          sourceKind === 'ARTIFACT'
            ? passive.filter((candidate) => matchesReference(candidate, reference))
            : [];
        return [resourceRecord(input.requestId, need, sourceKind, reference, operations, passiveMatches)];
      });
    });
  }
}

export function observeResourceOperation(input: {
  action: ContextRuntimeAction;
  observation: ToolObservation;
  metadata?: Record<string, unknown>;
}): {
  executionState: ExecutionState;
  resourceState: ResourceState;
  resourceCandidates: readonly ResourceCandidate[];
} {
  const executionState = executionStateFor(input.observation);
  const resourceCandidates = discoveredCandidates(input.action, input.observation, input.metadata);
  if (executionState === 'BLOCKED') {
    return { executionState, resourceState: 'RETRIEVAL_FAILED', resourceCandidates };
  }
  if (executionState === 'FAILED') {
    return { executionState, resourceState: 'RETRIEVAL_FAILED', resourceCandidates };
  }
  if (executionState === 'EMPTY') {
    return { executionState, resourceState: 'RETRIEVED_EMPTY', resourceCandidates };
  }
  if (input.action.phase === 'discovery') {
    if (input.action.capability === 'FILE_DISCOVERY') {
      return {
        executionState,
        resourceState: resourceCandidates.length > 0 ? 'FOUND' : 'VERIFIED_MISSING',
        resourceCandidates,
      };
    }
    return {
      executionState,
      resourceState:
        resourceCandidates.length > 0 || (input.observation.links?.length ?? 0) > 0
          ? 'FOUND'
          : 'RETRIEVED_EMPTY',
      resourceCandidates,
    };
  }
  return { executionState, resourceState: 'RETRIEVED_SUCCESSFULLY', resourceCandidates };
}

function resourceRecord(
  requestId: string,
  need: ContextNeed,
  sourceKind: ResourceRecord['sourceKind'],
  reference: string,
  operations: readonly RuntimeRetrievalOperation[],
  passiveCandidates: readonly ResourceCandidate[],
): ResourceRecord {
  const discoveryOperations = operations.filter((operation) => operation.phase === 'discovery');
  const retrievalOperations = operations.filter((operation) => operation.phase === 'retrieval');
  const candidates = dedupeCandidates([
    ...passiveCandidates,
    ...operations.flatMap((operation) => operation.resourceCandidates ?? []),
  ]).filter((candidate) => candidate.sourceKind === sourceKind);
  const retrieval = [...retrievalOperations].reverse().find(
    (operation) => operation.executionState !== 'NOT_EXECUTED',
  );
  const discovery = [...discoveryOperations].reverse().find(
    (operation) => operation.executionState !== 'NOT_EXECUTED',
  );
  let state: ResourceState = 'NOT_CHECKED';
  let reason = 'The relevant resource scope has not been checked.';
  if (retrieval) {
    state = retrieval.resourceState;
    reason = `Retrieval operation ${retrieval.id} ended as ${retrieval.executionState}.`;
  } else if (candidates.length > 0) {
    state = 'FOUND';
    reason =
      passiveCandidates.length > 0
        ? 'A matching same-session artifact reference was found in canonical metadata.'
        : 'A runtime discovery operation returned matching resource candidates.';
  } else if (discovery) {
    state = discovery.resourceState;
    reason = `Discovery operation ${discovery.id} established ${discovery.resourceState}.`;
  }
  return {
    id: `resource:${stableHash({ requestId, needId: need.id, sourceKind, reference })}`,
    requestId,
    needId: need.id,
    reference,
    sourceKind,
    state,
    candidates,
    discoveryOperationIds: discoveryOperations.map((operation) => operation.id),
    retrievalOperationIds: retrievalOperations.map((operation) => operation.id),
    ...(sourceKind === 'FILE' && discoveryOperations.length > 0
      ? { checkedScope: 'workspace' }
      : {}),
    reason,
    updatedAt: now(),
  };
}

function passiveArtifactCandidates(
  messages: readonly AgentMessage[],
  offloadedArtifacts: readonly OffloadedArtifact[],
): ResourceCandidate[] {
  const fromMessages = messages.flatMap((message) =>
    message.content.flatMap((block) => {
      if (block.type !== 'tool_result') return [];
      const artifact = asRecord(block.metadata?.artifact);
      if (!artifact || typeof artifact.id !== 'string') return [];
      const metadata = asRecord(artifact.metadata);
      const filename = typeof metadata?.filename === 'string' ? metadata.filename : undefined;
      const createdAt = typeof artifact.createdAt === 'string' ? artifact.createdAt : message.createdAt;
      return [
        {
          sourceKind: 'ARTIFACT' as const,
          identifier: artifact.id,
          ...(filename === undefined ? {} : { name: filename }),
          uri: `artifact://${artifact.id}`,
          artifactId: artifact.id,
          scope: dedupeStrings([
            typeof metadata?.sessionId === 'string' ? metadata.sessionId : '',
            typeof metadata?.turnId === 'string' ? metadata.turnId : '',
          ]),
          discoveredBy: 'conversation_metadata' as const,
          discoveredAt: createdAt,
        },
      ];
    }),
  );
  const fromOffloads = offloadedArtifacts.map<ResourceCandidate>((artifact) => ({
    sourceKind: 'ARTIFACT',
    identifier: artifact.artifactId,
    name: artifact.reference,
    uri: artifact.reference,
    artifactId: artifact.artifactId,
    scope: [],
    discoveredBy: 'context_offload',
    discoveredAt: artifact.createdAt,
  }));
  return dedupeCandidates([...fromMessages, ...fromOffloads]);
}

function discoveredCandidates(
  action: ContextRuntimeAction,
  observation: ToolObservation,
  metadata: Record<string, unknown> | undefined,
): ResourceCandidate[] {
  const discoveredAt = observation.createdAt;
  if (action.capability === 'FILE_DISCOVERY') {
    const count = typeof metadata?.count === 'number' ? metadata.count : undefined;
    if (count === 0 || /^no files matched\.?$/i.test(observation.content.trim())) return [];
    return dedupeStrings(
      observation.content
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => validDiscoveredPath(entry)),
    ).map((path) => ({
      sourceKind: 'FILE',
      identifier: path,
      name: basename(path),
      uri: path,
      path,
      scope: ['workspace'],
      discoveredBy: 'runtime_tool',
      discoveredAt,
    }));
  }
  if (action.capability === 'FILE_READ') {
    const source = asRecord(metadata?.source);
    const path =
      typeof source?.uri === 'string'
        ? source.uri
        : typeof action.input.path === 'string'
          ? action.input.path
          : undefined;
    return path
      ? [{
          sourceKind: 'FILE',
          identifier: path,
          name: basename(path),
          uri: path,
          path,
          scope: ['workspace'],
          discoveredBy: 'runtime_tool',
          discoveredAt,
        }]
      : [];
  }
  if (action.capability === 'ARTIFACT_READ') {
    const artifactId =
      typeof metadata?.artifactId === 'string'
        ? metadata.artifactId
        : typeof action.input.artifactId === 'string'
          ? action.input.artifactId
          : undefined;
    return artifactId
      ? [{
          sourceKind: 'ARTIFACT',
          identifier: artifactId,
          uri: `artifact://${artifactId}`,
          artifactId,
          scope: [],
          discoveredBy: 'runtime_tool',
          discoveredAt,
        }]
      : [];
  }
  return [];
}

function executionStateFor(observation: ToolObservation): ExecutionState {
  if (observation.outcome === 'denied') return 'BLOCKED';
  if (observation.outcome === 'error' || observation.outcome === 'malformed') return 'FAILED';
  if (observation.outcome === 'empty') return 'EMPTY';
  return 'SUCCESS';
}

function resourceReference(need: ContextNeed): string | undefined {
  for (const value of [need.inputs.reference, need.inputs.path, need.inputs.artifactId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function capabilitySourceKind(
  capability: RuntimeRetrievalOperation['capability'],
): ResourceRecord['sourceKind'] | undefined {
  if (capability === 'FILE_DISCOVERY' || capability === 'FILE_READ') return 'FILE';
  if (capability === 'ARTIFACT_DISCOVERY' || capability === 'ARTIFACT_READ') return 'ARTIFACT';
  return undefined;
}

function matchesReference(candidate: ResourceCandidate, reference: string): boolean {
  const normalized = reference.toLowerCase();
  return [candidate.identifier, candidate.name, candidate.uri, candidate.path, candidate.artifactId]
    .filter((value): value is string => typeof value === 'string')
    .some(
      (value) =>
        value.toLowerCase() === normalized ||
        basename(value).toLowerCase() === basename(reference).toLowerCase(),
    );
}

function dedupeCandidates(candidates: readonly ResourceCandidate[]): ResourceCandidate[] {
  const values = new Map<string, ResourceCandidate>();
  for (const candidate of candidates) {
    values.set(`${candidate.sourceKind}:${candidate.identifier.toLowerCase()}`, candidate);
  }
  return [...values.values()];
}

function validDiscoveredPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f]/.test(value) &&
    !/^no files matched\.?$/i.test(value)
  );
}

function basename(value: string): string {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

import type { AgentMessage } from '../core/messages.js';
import { AgentHarnessError } from '../core/errors.js';
import type { PersistedContextIntelligenceState } from '../context-intelligence/contracts.js';

export const PREPARED_CONTEXT_MAX_MESSAGES = 1_000;
export const PREPARED_CONTEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A provider-ready prefix prepared from the first `sourceMessageCount` canonical
 * messages. New canonical messages are appended as a tail when the session resumes.
 */
export type PreparedContextCheckpoint = {
  version: 1;
  sourceMessageCount: number;
  /** Detects a rewritten canonical prefix; normal session history is append-only. */
  sourceLastMessageId?: string;
  messages: AgentMessage[];
};

export type StoredSession = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  /** Prepared model context; canonical history always remains in `messages`. */
  preparedContext?: PreparedContextCheckpoint;
  /**
   * Governed task, memory, observation, and offload state. This is derived state;
   * canonical messages remain authoritative and an invalid block is discarded on
   * load without losing the session.
   */
  contextIntelligence?: PersistedContextIntelligenceState;
  metadata: Record<string, unknown>;
};

export type SessionStoreOptions = {
  /** Expire inactive sessions after this many milliseconds. Zero disables expiry. */
  ttlMs?: number;
  /** Maximum serialized size of one session. Defaults to 10 MiB. */
  maxBytes?: number;
};

export interface SessionStore {
  readonly kind?: 'memory' | 'file' | 's3' | 'custom';
  load(id: string): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>>;
}

export class InMemorySessionStore implements SessionStore {
  readonly kind = 'memory' as const;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly options: SessionStoreOptions = {}) {}

  async load(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    if (session && isExpired(session, this.options.ttlMs)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session ? validateStoredSession(structuredClone(session)) : undefined;
  }

  async save(session: StoredSession): Promise<void> {
    assertSessionSize(session, this.options.maxBytes);
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    for (const [id, session] of this.sessions) {
      if (isExpired(session, this.options.ttlMs)) this.sessions.delete(id);
    }
    return [...this.sessions.values()].map(({ id, createdAt, updatedAt, metadata }) => ({
      id,
      createdAt,
      updatedAt,
      metadata: structuredClone(metadata),
    }));
  }
}

export function isExpired(session: StoredSession, ttlMs = 0, now = Date.now()): boolean {
  if (ttlMs <= 0) return false;
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt + ttlMs <= now;
}

export function assertSessionSize(session: StoredSession, maximum = 10 * 1024 * 1024): void {
  const bytes = Buffer.byteLength(JSON.stringify(session), 'utf8');
  if (bytes > maximum) {
    throw new AgentHarnessError(
      `Session ${session.id} is ${bytes} bytes; maximum is ${maximum}`,
      'SESSION_TOO_LARGE',
    );
  }
}

export function validateStoredSession(value: unknown): StoredSession {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string' ||
    !('messages' in value) ||
    !Array.isArray(value.messages) ||
    !('metadata' in value) ||
    typeof value.metadata !== 'object' ||
    value.metadata === null ||
    Array.isArray(value.metadata)
  ) {
    throw new AgentHarnessError('Stored session is invalid', 'INVALID_STORED_SESSION');
  }
  const session = value as StoredSession & {
    preparedContext?: unknown;
    contextIntelligence?: unknown;
  };
  const preparedContext = validatePreparedContextCheckpoint(
    session.preparedContext,
    session.messages,
  );
  const contextIntelligence = validateContextIntelligenceState(session.contextIntelligence);
  const {
    preparedContext: _untrustedPrepared,
    contextIntelligence: _untrustedIntelligence,
    ...canonical
  } = session;
  return {
    ...canonical,
    ...(preparedContext === undefined ? {} : { preparedContext }),
    ...(contextIntelligence === undefined ? {} : { contextIntelligence }),
  };
}

const EXECUTABLE_CONTEXT_CAPABILITIES = new Set([
  'WEB_SEARCH',
  'WEB_FETCH',
  'FILE_DISCOVERY',
  'FILE_READ',
  'ARTIFACT_DISCOVERY',
  'DATABASE_QUERY',
  'API_RETRIEVAL',
  'MCP_RETRIEVAL',
  'MEMORY_RECALL',
  'TASK_STATE_READ',
  'ARTIFACT_READ',
  'APPLICATION_CONTEXT_READ',
  'MARKDOWN_ARTIFACT_CREATE',
  'DOCUMENT_ARTIFACT_CREATE',
]);
const RUNTIME_STRATEGIES = new Set([
  'INITIAL',
  'QUERY_REWRITE',
  'QUERY_EXPANSION',
  'QUERY_DECOMPOSITION',
  'SOURCE_SWITCH',
  'RETRIEVAL_BROADEN',
  'RETRIEVAL_NARROW',
  'ADDITIONAL_EVIDENCE',
  'TRANSIENT_RETRY',
  // Legacy v1 values accepted and normalized during restore.
  'initial',
  'refined_query',
  'alternate_source',
  'alternate_capability',
]);
const RUNTIME_STATUSES = new Set(['planned', 'succeeded', 'empty', 'failed', 'denied']);
const RUNTIME_PHASES = new Set(['discovery', 'retrieval']);
const EXECUTION_STATES = new Set(['SUCCESS', 'EMPTY', 'FAILED', 'BLOCKED', 'NOT_EXECUTED']);
const RESOURCE_STATES = new Set([
  'FOUND',
  'VERIFIED_MISSING',
  'NOT_CHECKED',
  'RETRIEVAL_FAILED',
  'RETRIEVED_EMPTY',
  'RETRIEVED_SUCCESSFULLY',
]);
const RETRIEVAL_RESULTS = new Set([
  'NO_RESULT',
  'EMPTY_RESULT',
  'LOW_RELEVANCE',
  'INSUFFICIENT_EVIDENCE',
  'STALE_EVIDENCE',
  'SOURCE_CONFLICT',
  'TOOL_FAILURE',
  'ACCESS_FAILURE',
  'INVALID_REFERENCE',
  'RETRIEVAL_SUCCESS',
]);
const RETRIEVAL_STATES = new Set([
  'NOT_EXECUTED',
  'IN_PROGRESS',
  'SUCCESS',
  'EMPTY',
  'FAILED',
  'RETRYING',
  'EXHAUSTED',
  'BLOCKED',
]);
const RETRIEVAL_TERMINATION_REASONS = new Set([
  'SUFFICIENT_EVIDENCE',
  'GROUNDING_SATISFIED',
  'RETRIEVAL_BUDGET_EXHAUSTED',
  'NO_USEFUL_ADAPTATION',
  'CLARIFICATION_REQUIRED',
  'CAPABILITY_UNAVAILABLE',
  'ACCESS_BLOCKED',
  'INVALID_REFERENCE',
  'UNRESOLVED_SOURCE_CONFLICT',
  'SAFE_CONTINUATION_IMPOSSIBLE',
]);
const FAILURE_CLASSIFICATIONS = new Set([
  'authorization_denied',
  'invalid_input',
  'not_found',
  'timeout',
  'network',
  'rate_limited',
  'unsupported',
  'irrelevant',
  'empty',
  'malformed',
  'unknown',
]);
const LIFECYCLE_STATES = new Set([
  'discovered',
  'retrieved',
  'observed',
  'evaluated',
  'admitted',
  'ranked',
  'used',
  'compressed',
  'offloaded',
  'recalled',
  'archived',
]);
const FEEDBACK_CATEGORIES = new Set([
  'retrieval',
  'tool_choice',
  'memory',
  'overflow',
  'quality_gate',
]);
const FEEDBACK_OUTCOMES = new Set([
  'useful',
  'irrelevant',
  'failed',
  'duplicate',
  'retained',
  'ignored_stale',
  'ignored_conflict',
  'omitted',
  'offloaded',
  'rejected',
]);
const FEEDBACK_REFERENCE_KINDS = new Set([
  'operation',
  'observation',
  'evidence',
  'retrieval_result',
  'memory',
  'context_item',
  'evidence_group',
  'finalization',
  'quality_decision',
]);
const QUALITY_DECISIONS = new Set([
  'ACCEPT',
  'RETRIEVE',
  'RETRIEVE_AGAIN',
  'CLARIFY',
  'CONFLICT',
  'DENY',
  'ABSTAIN',
]);
const QUALITY_STATUSES = new Set(['passed', 'degraded', 'insufficient', 'rejected']);
const UNAVAILABLE_EVALUATION_METRICS = new Set([
  'retrieval_recall',
  'answer_accuracy',
  'observed_cost',
]);
const UNAVAILABLE_EVALUATION_REASONS = new Set([
  'no_relevance_ground_truth',
  'no_accuracy_ground_truth',
  'no_observed_cost',
]);

function validateContextIntelligenceState(
  value: unknown,
): PersistedContextIntelligenceState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const allowedRootKeys = new Set([
    'version',
    'taskState',
    'memories',
    'observations',
    'offloadedArtifacts',
    'recentOperations',
    'lifecycleEvents',
    'feedback',
    'performanceProfiles',
    'lastEvaluation',
    'lastSnapshot',
    'lastContract',
    'updatedAt',
  ]);
  if (!hasOnlyKeys(root, allowedRootKeys)) return undefined;
  const candidate = value as Partial<PersistedContextIntelligenceState>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.memories) ||
    !Array.isArray(candidate.observations) ||
    !Array.isArray(candidate.offloadedArtifacts) ||
    !isBoundedString(candidate.updatedAt, 100) ||
    candidate.memories.length > 1_000 ||
    candidate.observations.length > 200 ||
    candidate.offloadedArtifacts.length > 200 ||
    !isValidOperationSnapshots(candidate.recentOperations) ||
    !isValidLifecycleSnapshots(candidate.lifecycleEvents) ||
    !isValidFeedback(candidate.feedback) ||
    !isValidPerformanceProfiles(candidate.performanceProfiles) ||
    !isValidEvaluation(candidate.lastEvaluation) ||
    !isValidContextSnapshot(candidate.lastSnapshot)
  ) {
    return undefined;
  }
  const p3Projection = {
    recentOperations: candidate.recentOperations,
    lifecycleEvents: candidate.lifecycleEvents,
    feedback: candidate.feedback,
    performanceProfiles: candidate.performanceProfiles,
    lastEvaluation: candidate.lastEvaluation,
    lastSnapshot: candidate.lastSnapshot,
  };
  if (serializedBytes(p3Projection) > 1_024 * 1_024) return undefined;
  // Accept the legacy key only long enough to migrate the state; never restore or
  // persist its content-bearing full contract.
  const { lastContract: _legacyContract, ...contentBoundedState } = candidate;
  if (serializedBytes(contentBoundedState) > 5 * 1_024 * 1_024) return undefined;
  return structuredClone({
    ...contentBoundedState,
    ...(candidate.recentOperations === undefined
      ? {}
      : { recentOperations: normalizeOperationSnapshots(candidate.recentOperations) }),
  } as PersistedContextIntelligenceState);
}

function isValidOperationSnapshots(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 200) return false;
  const allowed = new Set([
    'id',
    'retrievalPlanId',
    'requestId',
    'needId',
    'capability',
    'phase',
    'toolName',
    'attemptKey',
    'strategy',
    'adaptationReason',
    'previousStrategy',
    'nextStrategy',
    'priorOperationIds',
    'iteration',
    'status',
    'executionState',
    'resourceState',
    'failureClassification',
    'retrievalResult',
    'retrievalState',
    'remainingRetrievalBudget',
    'evidenceQuality',
    'contributedEvidence',
    'terminationReason',
    'observationId',
    'startedAt',
    'completedAt',
    'durationMs',
    'executionDurationMs',
    'observedCost',
  ]);
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const operation = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(operation, allowed) &&
      !('input' in operation) &&
      isBoundedString(operation.id, 300) &&
      isOptionalBoundedString(operation.retrievalPlanId, 300) &&
      isBoundedString(operation.requestId, 300) &&
      isBoundedString(operation.needId, 300) &&
      isOneOf(operation.capability, EXECUTABLE_CONTEXT_CAPABILITIES) &&
      isOptionalOneOf(operation.phase, RUNTIME_PHASES) &&
      isBoundedString(operation.toolName, 200) &&
      isBoundedString(operation.attemptKey, 300) &&
      isOneOf(operation.strategy, RUNTIME_STRATEGIES) &&
      isOptionalBoundedString(operation.adaptationReason, 1_000) &&
      isOptionalOneOf(operation.previousStrategy, RUNTIME_STRATEGIES) &&
      isOptionalOneOf(operation.nextStrategy, RUNTIME_STRATEGIES) &&
      (operation.priorOperationIds === undefined ||
        (Array.isArray(operation.priorOperationIds) &&
          operation.priorOperationIds.length <= 100 &&
          operation.priorOperationIds.every((id) => isBoundedString(id, 300)))) &&
      Number.isInteger(operation.iteration) &&
      isFiniteNonNegative(operation.iteration) &&
      isOneOf(operation.status, RUNTIME_STATUSES) &&
      isOptionalOneOf(operation.executionState, EXECUTION_STATES) &&
      isOptionalOneOf(operation.resourceState, RESOURCE_STATES) &&
      isBoundedString(operation.startedAt, 100) &&
      isOptionalOneOf(operation.failureClassification, FAILURE_CLASSIFICATIONS) &&
      isOptionalOneOf(operation.retrievalResult, RETRIEVAL_RESULTS) &&
      isOptionalOneOf(operation.retrievalState, RETRIEVAL_STATES) &&
      isOptionalFiniteNonNegative(operation.remainingRetrievalBudget) &&
      isValidRetrievalEvidenceQuality(operation.evidenceQuality) &&
      (operation.contributedEvidence === undefined ||
        typeof operation.contributedEvidence === 'boolean') &&
      isOptionalOneOf(operation.terminationReason, RETRIEVAL_TERMINATION_REASONS) &&
      isOptionalBoundedString(operation.observationId, 300) &&
      isOptionalBoundedString(operation.completedAt, 100) &&
      isOptionalFiniteNonNegative(operation.durationMs) &&
      isOptionalFiniteNonNegative(operation.executionDurationMs) &&
      isValidObservedCost(operation.observedCost)
    );
  });
}

function normalizeOperationSnapshots(
  operations: readonly Record<string, unknown>[],
): PersistedContextIntelligenceState['recentOperations'] {
  return operations.map((operation) => {
    const status = String(operation.status);
    const strategy = normalizeRetrievalStrategy(String(operation.strategy));
    const phase =
      operation.phase ??
      (operation.capability === 'WEB_SEARCH' ||
      operation.capability === 'FILE_DISCOVERY' ||
      operation.capability === 'ARTIFACT_DISCOVERY'
        ? 'discovery'
        : 'retrieval');
    const executionState =
      operation.executionState ??
      (status === 'succeeded'
        ? 'SUCCESS'
        : status === 'empty'
          ? 'EMPTY'
          : status === 'denied'
            ? 'BLOCKED'
            : status === 'failed'
              ? 'FAILED'
              : 'NOT_EXECUTED');
    const resourceState =
      operation.resourceState ??
      (executionState === 'SUCCESS'
        ? 'RETRIEVED_SUCCESSFULLY'
        : executionState === 'EMPTY'
          ? 'RETRIEVED_EMPTY'
          : executionState === 'NOT_EXECUTED'
            ? 'NOT_CHECKED'
            : 'RETRIEVAL_FAILED');
    const retrievalPlanId =
      typeof operation.retrievalPlanId === 'string'
        ? operation.retrievalPlanId
        : `legacy-retrieval-plan:${String(operation.id)}`;
    const priorOperationIds = Array.isArray(operation.priorOperationIds)
      ? operation.priorOperationIds.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      ...operation,
      retrievalPlanId,
      priorOperationIds,
      strategy,
      phase,
      executionState,
      resourceState,
    } as unknown as NonNullable<PersistedContextIntelligenceState['recentOperations']>[number];
  });
}

function normalizeRetrievalStrategy(value: string): string {
  if (value === 'initial') return 'INITIAL';
  if (value === 'refined_query') return 'QUERY_REWRITE';
  if (value === 'alternate_source' || value === 'alternate_capability') return 'SOURCE_SWITCH';
  return value;
}

function isValidRetrievalEvidenceQuality(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const quality = value as Record<string, unknown>;
  return (
    hasOnlyKeys(
      quality,
      new Set([
        'evidenceCount',
        'relevance',
        'authority',
        'freshness',
        'completeness',
        'confidence',
        'provenanceCompleteness',
        'conflictCount',
        'sufficient',
      ]),
    ) &&
    isFiniteNonNegative(quality.evidenceCount) &&
    isOptionalUnit(quality.relevance) &&
    isOptionalUnit(quality.authority) &&
    isOptionalUnit(quality.freshness) &&
    isOptionalUnit(quality.completeness) &&
    isOptionalUnit(quality.confidence) &&
    isOptionalUnit(quality.provenanceCompleteness) &&
    isFiniteNonNegative(quality.conflictCount) &&
    typeof quality.sufficient === 'boolean'
  );
}

function isValidLifecycleSnapshots(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 500) return false;
  const allowed = new Set([
    'id',
    'requestId',
    'itemId',
    'needId',
    'from',
    'to',
    'reasonCode',
    'component',
    'at',
  ]);
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const event = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(event, allowed) &&
      !('reason' in event) &&
      !('metadata' in event) &&
      isBoundedString(event.id, 300) &&
      isBoundedString(event.requestId, 300) &&
      isOptionalBoundedString(event.itemId, 300) &&
      isOptionalBoundedString(event.needId, 300) &&
      isOptionalOneOf(event.from, LIFECYCLE_STATES) &&
      isOneOf(event.to, LIFECYCLE_STATES) &&
      isBoundedString(event.reasonCode, 120) &&
      isBoundedString(event.component, 200) &&
      isBoundedString(event.at, 100)
    );
  });
}

function isValidObservedCost(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
  return (
    hasOnlyKeys(cost, new Set(['amount', 'unit', 'source'])) &&
    isFiniteNonNegative(cost.amount) &&
    isBoundedString(cost.unit, 50) &&
    (cost.source === 'tool_result_metadata' || cost.source === 'runtime_event')
  );
}

function isValidFeedback(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 1_000) return false;
  const allowed = new Set([
    'id',
    'requestId',
    'category',
    'outcome',
    'reasonCode',
    'operationId',
    'observationId',
    'evidenceId',
    'retrievalResultId',
    'memoryId',
    'toolName',
    'capability',
    'sourceReferences',
    'at',
  ]);
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(record, allowed) &&
      isBoundedString(record.id, 300) &&
      isBoundedString(record.requestId, 300) &&
      isOneOf(record.category, FEEDBACK_CATEGORIES) &&
      isOneOf(record.outcome, FEEDBACK_OUTCOMES) &&
      isBoundedString(record.reasonCode, 120) &&
      isOptionalBoundedString(record.operationId, 300) &&
      isOptionalBoundedString(record.observationId, 300) &&
      isOptionalBoundedString(record.evidenceId, 300) &&
      isOptionalBoundedString(record.retrievalResultId, 300) &&
      isOptionalBoundedString(record.memoryId, 300) &&
      isOptionalBoundedString(record.toolName, 200) &&
      isOptionalOneOf(record.capability, EXECUTABLE_CONTEXT_CAPABILITIES) &&
      isValidFeedbackReferences(record.sourceReferences) &&
      isBoundedString(record.at, 100)
    );
  });
}

function isValidFeedbackReferences(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const reference = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(reference, new Set(['kind', 'id'])) &&
      isOneOf(reference.kind, FEEDBACK_REFERENCE_KINDS) &&
      isBoundedString(reference.id, 500)
    );
  });
}

function isValidPerformanceProfiles(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100) return false;
  const allowed = new Set([
    'toolName',
    'capability',
    'completedSamples',
    'succeededSamples',
    'usefulSamples',
    'irrelevantSamples',
    'failedSamples',
    'duplicateSamples',
    'classifiedSamples',
    'durationSamples',
    'totalDurationMs',
    'observedCosts',
    'processedOperationIds',
    'updatedAt',
  ]);
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const profile = entry as Record<string, unknown>;
    const counters = [
      'completedSamples',
      'succeededSamples',
      'usefulSamples',
      'irrelevantSamples',
      'failedSamples',
      'duplicateSamples',
      'classifiedSamples',
      'durationSamples',
    ];
    return (
      hasOnlyKeys(profile, allowed) &&
      isBoundedString(profile.toolName, 200) &&
      isOneOf(profile.capability, EXECUTABLE_CONTEXT_CAPABILITIES) &&
      counters.every((key) => isNonNegativeInteger(profile[key])) &&
      isFiniteNonNegative(profile.totalDurationMs) &&
      isValidCostGroups(profile.observedCosts) &&
      isBoundedStringArray(profile.processedOperationIds, 200) &&
      isBoundedString(profile.updatedAt, 100)
    );
  });
}

function isValidCostGroups(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const cost = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(cost, new Set(['unit', 'samples', 'total'])) &&
      isBoundedString(cost.unit, 50) &&
      isNonNegativeInteger(cost.samples) &&
      isFiniteNonNegative(cost.total)
    );
  });
}

function isValidEvaluation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evaluation = value as Record<string, unknown>;
  const allowed = new Set([
    'operationSuccess',
    'classifiedRetrievalUsefulness',
    'evidenceUtilization',
    'memoryRetention',
    'gateRejection',
    'unclassifiedRetrievalOperations',
    'latency',
    'costs',
    'unavailable',
    'evaluatedAt',
  ]);
  return (
    hasOnlyKeys(evaluation, allowed) &&
    [
      'operationSuccess',
      'classifiedRetrievalUsefulness',
      'evidenceUtilization',
      'memoryRetention',
      'gateRejection',
    ].every((key) => isValidMeasuredRatio(evaluation[key])) &&
    isNonNegativeInteger(evaluation.unclassifiedRetrievalOperations) &&
    isValidLatency(evaluation.latency) &&
    isValidCostGroups(evaluation.costs) &&
    isValidUnavailableMetrics(evaluation.unavailable) &&
    isBoundedString(evaluation.evaluatedAt, 100) &&
    serializedBytes(value) <= 64 * 1_024
  );
}

function isValidMeasuredRatio(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ratio = value as Record<string, unknown>;
  return (
    hasOnlyKeys(ratio, new Set(['numerator', 'denominator', 'value'])) &&
    isNonNegativeInteger(ratio.numerator) &&
    typeof ratio.denominator === 'number' &&
    Number.isInteger(ratio.denominator) &&
    ratio.denominator > 0 &&
    typeof ratio.value === 'number' &&
    Number.isFinite(ratio.value) &&
    ratio.value >= 0 &&
    ratio.value <= 1
  );
}

function isValidLatency(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const latency = value as Record<string, unknown>;
  return (
    hasOnlyKeys(latency, new Set(['samples', 'totalMs', 'meanMs', 'minimumMs', 'maximumMs'])) &&
    isNonNegativeInteger(latency.samples) &&
    isFiniteNonNegative(latency.totalMs) &&
    isOptionalFiniteNonNegative(latency.meanMs) &&
    isOptionalFiniteNonNegative(latency.minimumMs) &&
    isOptionalFiniteNonNegative(latency.maximumMs)
  );
}

function isValidUnavailableMetrics(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const unavailable = entry as Record<string, unknown>;
    return (
      hasOnlyKeys(unavailable, new Set(['metric', 'reason'])) &&
      isOneOf(unavailable.metric, UNAVAILABLE_EVALUATION_METRICS) &&
      isOneOf(unavailable.reason, UNAVAILABLE_EVALUATION_REASONS)
    );
  });
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOneOf(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === 'string' && values.has(value);
}

function isOptionalOneOf(value: unknown, values: ReadonlySet<string>): boolean {
  return value === undefined || isOneOf(value, values);
}

function isOptionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined || isFiniteNonNegative(value);
}

function isOptionalUnit(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function isOptionalBoundedString(value: unknown, maximumLength: number): boolean {
  return value === undefined || isBoundedString(value, maximumLength);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isValidContextSnapshot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    hasOnlyKeys(
      snapshot,
      new Set([
        'version',
        'requestId',
        'taskId',
        'decision',
        'qualityStatus',
        'activeItemIds',
        'evidenceIds',
        'offloadedArtifactIds',
        'lifecycleEventIds',
        'updatedAt',
      ]),
    ) &&
    snapshot.version === 1 &&
    isBoundedString(snapshot.requestId, 200) &&
    isBoundedString(snapshot.taskId, 200) &&
    isOneOf(snapshot.decision, QUALITY_DECISIONS) &&
    isOneOf(snapshot.qualityStatus, QUALITY_STATUSES) &&
    isBoundedStringArray(snapshot.activeItemIds, 1_000) &&
    isBoundedStringArray(snapshot.evidenceIds, 1_000) &&
    isBoundedStringArray(snapshot.offloadedArtifactIds, 200) &&
    isBoundedStringArray(snapshot.lifecycleEventIds, 500) &&
    isBoundedString(snapshot.updatedAt, 100)
  );
}

function isBoundedStringArray(value: unknown, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => isBoundedString(entry, 500))
  );
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength;
}

export function createPreparedContextCheckpoint(
  messages: readonly AgentMessage[],
  canonicalMessages: readonly AgentMessage[],
): PreparedContextCheckpoint | undefined {
  const sourceMessageCount = canonicalMessages.length;
  const checkpoint: PreparedContextCheckpoint = {
    version: 1,
    sourceMessageCount,
    ...(sourceMessageCount === 0
      ? {}
      : { sourceLastMessageId: canonicalMessages[sourceMessageCount - 1]!.id }),
    messages: structuredClone([...messages]),
  };
  return validatePreparedContextCheckpoint(checkpoint, canonicalMessages);
}

export function validatePreparedContextCheckpoint(
  value: unknown,
  canonicalMessages: readonly AgentMessage[],
): PreparedContextCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PreparedContextCheckpoint>;
  const sourceCount = candidate.sourceMessageCount;
  if (
    candidate.version !== 1 ||
    !Number.isInteger(sourceCount) ||
    sourceCount === undefined ||
    sourceCount < 0 ||
    sourceCount > canonicalMessages.length ||
    (sourceCount > 0 && candidate.sourceLastMessageId !== canonicalMessages[sourceCount - 1]?.id) ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length > PREPARED_CONTEXT_MAX_MESSAGES ||
    !candidate.messages.every(isAgentMessage)
  ) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PREPARED_CONTEXT_MAX_BYTES) {
    return undefined;
  }
  if (!hasCompleteToolPairs(candidate.messages)) return undefined;
  return structuredClone(candidate as PreparedContextCheckpoint);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<AgentMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.createdAt === 'string' &&
    (message.reasoning === undefined || typeof message.reasoning === 'string') &&
    Array.isArray(message.content) &&
    message.content.every((block) => {
      if (!block || typeof block !== 'object' || !('type' in block)) return false;
      switch (block.type) {
        case 'text':
          return 'text' in block && typeof block.text === 'string';
        case 'tool_call':
          return (
            'id' in block &&
            typeof block.id === 'string' &&
            'name' in block &&
            typeof block.name === 'string' &&
            'input' in block
          );
        case 'tool_result':
          return (
            'toolCallId' in block &&
            typeof block.toolCallId === 'string' &&
            'content' in block &&
            typeof block.content === 'string' &&
            'isError' in block &&
            typeof block.isError === 'boolean'
          );
        case 'image':
          return (
            'mediaType' in block &&
            typeof block.mediaType === 'string' &&
            'data' in block &&
            typeof block.data === 'string' &&
            (!('filename' in block) ||
              block.filename === undefined ||
              typeof block.filename === 'string')
          );
        default:
          return false;
      }
    })
  );
}

function hasCompleteToolPairs(messages: readonly AgentMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') calls.add(block.id);
      if (block.type === 'tool_result') results.add(block.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id)) && [...results].every((id) => calls.has(id));
}

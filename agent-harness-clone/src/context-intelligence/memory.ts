import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextNeed,
  ContextScope,
  EvidenceItem,
  MemoryAdmissionDecision,
  MemoryItem,
  MemoryRecallAssessment,
  MemoryType,
  NormalizedIntent,
  Provenance,
  RetrievalResult,
  TaskState,
  TaskStep,
} from './contracts.js';
import {
  clamp,
  deepClone,
  dedupeStrings,
  freshnessScore,
  id,
  lexicalSimilarity,
  now,
  provenance,
  sourceMetadata,
  stableHash,
} from './utils.js';

export type MemoryQuery = {
  scope: ContextScope;
  intent: NormalizedIntent;
  types?: readonly MemoryType[];
  limit: number;
  signal: AbortSignal;
};

export interface MemoryProvider {
  recall(query: MemoryQuery): Promise<readonly MemoryItem[]>;
  get(idValue: string): Promise<MemoryItem | undefined>;
  upsert(item: MemoryItem): Promise<void>;
  remove(idValue: string): Promise<boolean>;
  list(scope: ContextScope): Promise<readonly MemoryItem[]>;
}

/**
 * A serializable provider used inside one persistent Harness session. Its contents
 * are exported into `StoredSession.contextIntelligence`, so it inherits the
 * deployment's existing memory/file/S3 session durability and concurrency rules.
 */
export class SessionMemoryProvider implements MemoryProvider {
  private readonly items = new Map<string, MemoryItem>();

  constructor(initial: readonly MemoryItem[] = []) {
    for (const item of initial) this.items.set(item.id, deepClone(item));
  }

  async recall(query: MemoryQuery): Promise<readonly MemoryItem[]> {
    return (await this.list(query.scope))
      .filter((item) => !query.types || query.types.includes(item.type))
      .slice(0, query.limit);
  }

  async get(idValue: string): Promise<MemoryItem | undefined> {
    const item = this.items.get(idValue);
    return item ? deepClone(item) : undefined;
  }

  async upsert(item: MemoryItem): Promise<void> {
    this.items.set(item.id, deepClone(item));
  }

  async remove(idValue: string): Promise<boolean> {
    return this.items.delete(idValue);
  }

  async list(scope: ContextScope): Promise<readonly MemoryItem[]> {
    return [...this.items.values()]
      .filter((item) => scopeMatches(item.scope, scope))
      .map((item) => deepClone(item));
  }

  snapshot(): readonly MemoryItem[] {
    return [...this.items.values()].map((item) => deepClone(item));
  }
}

/** Routes task-local memory to the session and durable memory to an application provider. */
export class LayeredMemoryProvider implements MemoryProvider {
  constructor(
    private readonly session: SessionMemoryProvider,
    private readonly durable: MemoryProvider,
  ) {}

  async recall(query: MemoryQuery): Promise<readonly MemoryItem[]> {
    const [local, durable] = await Promise.all([
      this.session.recall(query),
      this.durable.recall(query),
    ]);
    return dedupeMemory([...local, ...durable]).slice(0, query.limit);
  }

  async get(idValue: string): Promise<MemoryItem | undefined> {
    return (await this.session.get(idValue)) ?? (await this.durable.get(idValue));
  }

  async upsert(item: MemoryItem): Promise<void> {
    if (item.type === 'short-term' || item.type === 'working') await this.session.upsert(item);
    else await this.durable.upsert(item);
  }

  async remove(idValue: string): Promise<boolean> {
    const local = await this.session.remove(idValue);
    const durable = await this.durable.remove(idValue);
    return local || durable;
  }

  async list(scope: ContextScope): Promise<readonly MemoryItem[]> {
    const [local, durable] = await Promise.all([
      this.session.list(scope),
      this.durable.list(scope),
    ]);
    return dedupeMemory([...local, ...durable]);
  }
}

export type MemoryCandidate = {
  type: Exclude<MemoryType, 'short-term' | 'working'>;
  content: string;
  structured?: unknown;
  labels?: readonly string[];
  entities?: readonly string[];
  confidence: number;
  authority: number;
  durability: number;
  usefulness: number;
  privacy?: MemoryItem['privacy'];
  expiresAt?: string;
  provenance?: Provenance;
};

export class MemoryIntelligence {
  constructor(
    private readonly config: ContextIntelligenceConfig['memory'],
    private readonly provider: MemoryProvider,
  ) {}

  async recall(
    intent: NormalizedIntent,
    scope: ContextScope,
    signal: AbortSignal,
    types?: readonly MemoryType[],
  ): Promise<readonly MemoryItem[]> {
    try {
      const candidates = await this.provider.recall({
        scope,
        intent,
        ...(types === undefined ? {} : { types }),
        limit: Math.max(this.config.recallLimit * 4, this.config.recallLimit),
        signal,
      });
      const current = Date.now();
      return candidates
        .filter((item) => item.status === 'active' && !isExpired(item, current))
        .map((item) => ({ item, score: memoryScore(item, intent, scope, current) }))
        .filter((entry) => entry.score >= this.config.relevanceThreshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, this.config.recallLimit)
        .map(({ item, score }) => ({
          ...item,
          layer: item.layer ?? memoryLayer(item.type),
          relevance: score,
          retentionDecision: 'retain' as const,
          lastAccessedAt: now(),
        }));
    } catch {
      return [];
    }
  }

  reconcile(
    memories: readonly MemoryItem[],
    evidence: readonly (EvidenceItem | RetrievalResult)[],
    needs: readonly ContextNeed[],
  ): MemoryRecallAssessment {
    const retained: MemoryItem[] = [];
    const ignoredIds: string[] = [];
    const staleIds: string[] = [];
    const conflictingIds: string[] = [];
    const requiresFreshMemory = needs.some(
      (need) =>
        need.sourceKinds.includes('MEMORY') &&
        !['ANY', 'NONE', 'HISTORICAL'].includes(need.freshnessRequirement),
    );
    const requiresCurrentEvidence = needs.some((need) =>
      ['CURRENT', 'LATEST', 'RECENT', 'TODAY', 'THIS_WEEK'].includes(
        need.freshnessRequirement,
      ),
    );
    for (const memory of memories) {
      const recency = freshnessScore(memory.updatedAt, 90 * 24 * 60 * 60 * 1_000);
      const overlappingCurrentEvidence = evidence.some(
        (item) =>
          lexicalSimilarity(memory.content, item.content) >= 0.25 &&
          item.authority >= memory.authority &&
          item.freshness >= recency,
      );
      if (
        (requiresFreshMemory && recency < 0.6) ||
        (requiresCurrentEvidence && recency < 0.6 && overlappingCurrentEvidence)
      ) {
        ignoredIds.push(memory.id);
        staleIds.push(memory.id);
        continue;
      }
      const conflicts = evidence.filter(
        (item) =>
          lexicalSimilarity(memory.content, item.content) >= 0.4 &&
          contradictionHint(memory.content, item.content) &&
          item.authority >= memory.authority &&
          item.confidence >= memory.confidence,
      );
      if (conflicts.length > 0) {
        ignoredIds.push(memory.id);
        conflictingIds.push(memory.id);
        continue;
      }
      retained.push({
        ...memory,
        layer: memory.layer ?? memoryLayer(memory.type),
        retentionDecision: 'retain',
      });
    }
    return { retained, ignoredIds, staleIds, conflictingIds };
  }

  async evaluate(candidate: MemoryCandidate, scope: ContextScope): Promise<MemoryAdmissionDecision> {
    const item = candidateToItem(candidate, scope, this.config.defaultTtlMs);
    if (!candidate.content.trim()) return { action: 'reject', candidate: item, reason: 'empty memory' };
    if (!this.config.allowedPrivacy.includes(item.privacy)) {
      return { action: 'reject', candidate: item, reason: `privacy class ${item.privacy} is not admitted` };
    }
    if (candidate.confidence < this.config.admissionThreshold) {
      return { action: 'reject', candidate: item, reason: 'confidence below admission threshold' };
    }
    if ((candidate.durability + candidate.usefulness + candidate.authority) / 3 < this.config.admissionThreshold) {
      return { action: 'reject', candidate: item, reason: 'durability/usefulness/authority below admission threshold' };
    }
    const existing = (await this.provider.list(scope)).filter(
      (entry) => entry.type === candidate.type && entry.status === 'active',
    );
    const exact = existing.find(
      (entry) => stableHash(entry.structured ?? entry.content) === stableHash(candidate.structured ?? candidate.content),
    );
    if (exact) {
      return {
        action: 'update',
        candidate: { ...item, id: exact.id, version: exact.version + 1, createdAt: exact.createdAt },
        existingId: exact.id,
        reason: 'refreshes an existing memory',
      };
    }
    const related = existing.find((entry) => lexicalSimilarity(entry.content, candidate.content) >= 0.72);
    if (related) {
      const contradictory = contradictionHint(related.content, candidate.content);
      if (contradictory) {
        return {
          action: 'supersede',
          candidate: { ...item, supersedes: related.id },
          existingId: related.id,
          reason: 'newer admitted memory supersedes related content',
        };
      }
      return {
        action: 'merge',
        candidate: {
          ...item,
          id: related.id,
          content: mergeMemory(related.content, item.content),
          labels: dedupeStrings([...related.labels, ...item.labels]),
          entities: dedupeStrings([...related.entities, ...item.entities]),
          version: related.version + 1,
          createdAt: related.createdAt,
        },
        existingId: related.id,
        reason: 'related non-conflicting memory merged',
      };
    }
    return { action: 'approve', candidate: item, reason: 'candidate passed admission policy' };
  }

  async admit(candidate: MemoryCandidate, scope: ContextScope): Promise<MemoryAdmissionDecision> {
    const decision = await this.evaluate(candidate, scope);
    if (decision.action === 'reject') return decision;
    if (decision.action === 'supersede' && decision.existingId) {
      const existing = await this.provider.get(decision.existingId);
      if (existing) await this.provider.upsert({ ...existing, status: 'superseded', updatedAt: now() });
    }
    await this.provider.upsert(decision.candidate);
    await this.prune(scope);
    return decision;
  }

  async expire(scope: ContextScope, current = Date.now()): Promise<number> {
    let count = 0;
    for (const item of await this.provider.list(scope)) {
      if (item.status === 'active' && isExpired(item, current)) {
        await this.provider.upsert({ ...item, status: 'expired', updatedAt: now() });
        count += 1;
      }
    }
    return count;
  }

  async delete(idValue: string): Promise<boolean> {
    const item = await this.provider.get(idValue);
    if (!item) return false;
    const { structured: _discarded, ...withoutContent } = item;
    await this.provider.upsert({
      ...withoutContent,
      status: 'deleted',
      content: '',
      updatedAt: now(),
    });
    return true;
  }

  async prune(scope: ContextScope): Promise<number> {
    await this.expire(scope);
    const items = [...(await this.provider.list(scope))];
    if (items.length <= this.config.maximumItems) return 0;
    const removable = items
      .sort((left, right) => lifecycleScore(left) - lifecycleScore(right));
    let removed = 0;
    while (items.length - removed > this.config.maximumItems && removable.length > 0) {
      const item = removable.shift();
      if (item && (await this.provider.remove(item.id))) removed += 1;
    }
    return removed;
  }
}

export class TaskStateManager {
  recover(existing: TaskState | undefined, intent: NormalizedIntent, taskId: string): TaskState {
    if (existing && existing.status === 'active' && relatedGoal(existing.goal, intent.goal)) {
      const recovered = normalizeTaskState(existing);
      const nextAction = nextPendingAction(recovered.plan);
      return {
        ...recovered,
        goal: intent.goal,
        objective: intent.goal,
        currentPhase: currentPhase(recovered.plan),
        constraints: dedupeStrings([...recovered.constraints, ...intent.constraints]),
        pendingWork: recovered.plan
          .filter((step) => step.status !== 'completed')
          .map((step) => step.description),
        ...(nextAction === undefined ? {} : { nextAction }),
        updatedAt: now(),
      };
    }
    const steps = initialSteps(intent);
    const nextAction = nextPendingAction(steps);
    return {
      taskId,
      goal: intent.goal,
      objective: intent.goal,
      currentPhase: currentPhase(steps),
      scope: intent.entities.map((entity) => entity.value),
      plan: steps,
      completedSteps: [],
      pendingSteps: steps.map((step) => step.id),
      completedWork: [],
      pendingWork: steps.map((step) => step.description),
      retrievedEvidence: [],
      constraints: [...intent.constraints],
      confirmations: [],
      retries: 0,
      receipts: [],
      unresolvedIssues: [...intent.ambiguity],
      unresolvedQuestions: [...intent.ambiguity],
      failedAttempts: [],
      executionHistory: [],
      successfulOperations: [],
      emptyOperations: [],
      failedOperations: [],
      blockedOperations: [],
      notExecutedOperations: [],
      decisions: [],
      pendingDecisions: [],
      dependencies: steps.map((step) => ({
        id: step.id,
        dependsOn: step.dependencies,
        status: step.dependencies.length === 0 ? 'ready' : 'pending',
      })),
      ...(nextAction === undefined ? {} : { nextAction }),
      variables: {},
      status: 'active',
      updatedAt: now(),
    };
  }

  recordObservation(
    state: TaskState,
    input: {
      operationId?: string;
      receiptId?: string;
      executionState: TaskState['executionHistory'][number]['state'];
      issue?: string;
    },
  ): TaskState {
    const normalized = normalizeTaskState(state);
    const { pendingOperation: _previousPendingOperation, ...stateWithoutPendingOperation } =
      normalized;
    const targetStep =
      normalized.plan.find((step) => step.status === 'in_progress') ??
      normalized.plan.find((step) =>
        ['pending', 'failed', 'blocked', 'not_executed', 'completed_with_no_evidence'].includes(
          step.status,
        ),
      ) ?? normalized.plan.at(-1);
    const disposition = taskDisposition(input.executionState);
    const plan = normalized.plan.map((step) => {
      if (step.id !== targetStep?.id) return step;
      return {
        ...step,
        status: taskStepStatus(input.executionState),
        attempts: step.attempts + 1,
        ...(input.receiptId === undefined
          ? {}
          : { receiptIds: dedupeStrings([...step.receiptIds, input.receiptId]) }),
        lastExecutionState: input.executionState,
        updatedAt: now(),
      };
    });
    const completedSteps = plan
      .filter((step) => step.status === 'completed')
      .map((step) => step.id);
    const pendingSteps = plan
      .filter((step) => step.status !== 'completed')
      .map((step) => step.id);
    const nextAction = nextPendingAction(plan);
    return {
      ...stateWithoutPendingOperation,
      plan,
      currentPhase: currentPhase(plan),
      completedSteps,
      pendingSteps,
      completedWork: plan
        .filter((step) => step.status === 'completed')
        .map((step) => step.description),
      pendingWork: plan
        .filter((step) => step.status !== 'completed')
        .map((step) => step.description),
      retries:
        normalized.retries +
        (input.executionState === 'FAILED' || input.executionState === 'BLOCKED' ? 1 : 0),
      receipts: input.receiptId
        ? dedupeStrings([...normalized.receipts, input.receiptId])
        : normalized.receipts,
      unresolvedIssues: input.issue
        ? dedupeStrings([...normalized.unresolvedIssues, input.issue])
        : normalized.unresolvedIssues,
      unresolvedQuestions:
        input.issue && /\?|clarif|missing|unknown/i.test(input.issue)
          ? dedupeStrings([...normalized.unresolvedQuestions, input.issue])
          : normalized.unresolvedQuestions,
      failedAttempts:
        input.executionState !== 'FAILED' && input.executionState !== 'BLOCKED'
          ? normalized.failedAttempts
        : [
            ...normalized.failedAttempts,
            {
              ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
              ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
              ...(targetStep === undefined ? {} : { stepId: targetStep.id }),
              executionState: input.executionState,
              reason: input.issue ?? 'Context retrieval attempt failed.',
              at: now(),
            },
          ].slice(-100),
      executionHistory: [
        ...normalized.executionHistory,
        {
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
          ...(targetStep === undefined ? {} : { stepId: targetStep.id }),
          state: input.executionState,
          disposition,
          ...(input.issue === undefined ? {} : { reason: input.issue }),
          at: now(),
        },
      ].slice(-200),
      successfulOperations: appendOperation(
        normalized.successfulOperations,
        input,
        'SUCCESS',
      ),
      emptyOperations: appendOperation(normalized.emptyOperations, input, 'EMPTY'),
      failedOperations: appendOperation(normalized.failedOperations, input, 'FAILED'),
      blockedOperations: appendOperation(normalized.blockedOperations, input, 'BLOCKED'),
      notExecutedOperations:
        input.executionState === 'NOT_EXECUTED'
          ? appendOperation(normalized.notExecutedOperations, input, 'NOT_EXECUTED')
          : input.operationId
            ? normalized.notExecutedOperations.filter(
                (operationId) => operationId !== input.operationId,
              )
            : normalized.notExecutedOperations,
      ...(input.executionState === 'NOT_EXECUTED' && input.operationId
        ? { pendingOperation: input.operationId }
        : {}),
      dependencies: plan.map((step) => ({
        id: step.id,
        dependsOn: step.dependencies,
        status:
          step.status === 'completed'
            ? ('satisfied' as const)
            : step.dependencies.every((dependency) => completedSteps.includes(dependency))
              ? ('ready' as const)
              : ('blocked' as const),
      })),
      ...(nextAction === undefined ? {} : { nextAction }),
      updatedAt: now(),
    };
  }

  recordPlanned(state: TaskState, operationId: string): TaskState {
    const normalized = normalizeTaskState(state);
    if (normalized.notExecutedOperations.includes(operationId)) {
      return {
        ...normalized,
        pendingOperation: operationId,
        updatedAt: now(),
      };
    }
    const timestamp = now();
    return {
      ...normalized,
      pendingOperation: operationId,
      notExecutedOperations: dedupeStrings([
        ...normalized.notExecutedOperations,
        operationId,
      ]),
      executionHistory: [
        ...normalized.executionHistory,
        {
          operationId,
          state: 'NOT_EXECUTED' as const,
          disposition: 'NOT_EXECUTED' as const,
          reason: 'The operation is planned and has not produced a runtime receipt.',
          at: timestamp,
        },
      ].slice(-200),
      updatedAt: timestamp,
    };
  }

  recordEvidence(state: TaskState, evidenceIds: readonly string[]): TaskState {
    const normalized = normalizeTaskState(state);
    return {
      ...normalized,
      retrievedEvidence: dedupeStrings([...normalized.retrievedEvidence, ...evidenceIds]),
      plan: normalized.plan.map((step) =>
        step.status === 'in_progress' ||
        (step.status === 'completed' &&
          !normalized.plan.some((candidate) => candidate.status === 'in_progress'))
          ? { ...step, evidenceIds: dedupeStrings([...step.evidenceIds, ...evidenceIds]) }
          : step,
      ),
      updatedAt: now(),
    };
  }

  recordDecision(state: TaskState, decision: string): TaskState {
    const normalized = normalizeTaskState(state);
    return {
      ...normalized,
      decisions: dedupeStrings([...normalized.decisions, decision]),
      pendingDecisions: normalized.pendingDecisions.filter((entry) => entry !== decision),
      updatedAt: now(),
    };
  }

  complete(
    state: TaskState,
    successful: boolean,
    unresolvedIssues: readonly string[] = [],
  ): TaskState {
    const normalized = normalizeTaskState(state);
    const blockingStep = normalized.plan.find((step) =>
      ['failed', 'blocked', 'completed_with_no_evidence', 'not_executed'].includes(step.status),
    );
    const canComplete = successful && blockingStep === undefined;
    const plan = canComplete
      ? normalized.plan.map((step) => ({
          ...step,
          status: 'completed' as const,
          updatedAt: now(),
        }))
      : normalized.plan;
    const failed = blockingStep?.status === 'failed' || blockingStep?.status === 'completed_with_no_evidence';
    return {
      ...normalized,
      plan,
      status: canComplete ? 'completed' : failed ? 'failed' : unresolvedIssues.length ? 'blocked' : 'failed',
      currentPhase: canComplete ? 'completed' : failed ? 'failed' : 'blocked',
      unresolvedIssues: dedupeStrings([...normalized.unresolvedIssues, ...unresolvedIssues]),
      unresolvedQuestions: dedupeStrings([
        ...normalized.unresolvedQuestions,
        ...unresolvedIssues,
      ]),
      completedSteps: canComplete ? plan.map((step) => step.id) : normalized.completedSteps,
      completedWork: canComplete ? plan.map((step) => step.description) : normalized.completedWork,
      pendingSteps: canComplete ? [] : normalized.pendingSteps,
      pendingWork: canComplete ? [] : normalized.pendingWork,
      ...(canComplete
        ? { nextAction: 'none' }
        : normalized.nextAction === undefined
          ? {}
          : { nextAction: normalized.nextAction }),
      updatedAt: now(),
    };
  }
}

function normalizeTaskState(state: TaskState): TaskState {
  const candidate = state as TaskState & Partial<TaskState>;
  const plan = Array.isArray(candidate.plan) ? candidate.plan : [];
  const nextAction = candidate.nextAction ?? nextPendingAction(plan);
  return {
    ...state,
    objective: candidate.objective ?? candidate.goal,
    currentPhase: candidate.currentPhase ?? currentPhase(plan),
    completedWork:
      candidate.completedWork ??
      plan.filter((step) => step.status === 'completed').map((step) => step.description),
    pendingWork:
      candidate.pendingWork ??
      plan
        .filter((step) => step.status !== 'completed')
        .map((step) => step.description),
    retrievedEvidence: candidate.retrievedEvidence ?? [],
    unresolvedQuestions: candidate.unresolvedQuestions ?? candidate.unresolvedIssues ?? [],
    failedAttempts: candidate.failedAttempts ?? [],
    executionHistory: candidate.executionHistory ?? [],
    successfulOperations: candidate.successfulOperations ?? [],
    emptyOperations: candidate.emptyOperations ?? [],
    failedOperations: candidate.failedOperations ?? [],
    blockedOperations: candidate.blockedOperations ?? [],
    notExecutedOperations: candidate.notExecutedOperations ?? [],
    decisions: candidate.decisions ?? [],
    dependencies:
      candidate.dependencies ??
      plan.map((step) => ({
        id: step.id,
        dependsOn: step.dependencies,
        status: step.dependencies.length === 0 ? ('ready' as const) : ('pending' as const),
      })),
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

function currentPhase(plan: readonly TaskStep[]): string {
  return (
    plan.find((step) => step.status === 'in_progress')?.description ??
    plan.find((step) =>
      ['pending', 'not_executed', 'completed_with_no_evidence', 'failed', 'blocked'].includes(
        step.status,
      ),
    )?.description ??
    (plan.every((step) => step.status === 'completed') ? 'completed' : 'planning')
  );
}

function nextPendingAction(plan: readonly TaskStep[]): string | undefined {
  return plan.find((step) =>
    ['in_progress', 'pending', 'not_executed', 'completed_with_no_evidence', 'failed', 'blocked'].includes(
      step.status,
    ),
  )?.description;
}

function taskStepStatus(
  state: TaskState['executionHistory'][number]['state'],
): TaskStep['status'] {
  if (state === 'SUCCESS') return 'completed';
  if (state === 'EMPTY') return 'completed_with_no_evidence';
  if (state === 'FAILED') return 'failed';
  if (state === 'BLOCKED') return 'blocked';
  return 'not_executed';
}

function taskDisposition(
  state: TaskState['executionHistory'][number]['state'],
): TaskState['executionHistory'][number]['disposition'] {
  if (state === 'SUCCESS') return 'COMPLETED';
  if (state === 'EMPTY') return 'COMPLETED_WITH_NO_EVIDENCE';
  if (state === 'FAILED') return 'FAILED';
  if (state === 'BLOCKED') return 'BLOCKED';
  return 'NOT_EXECUTED';
}

function appendOperation(
  current: readonly string[],
  input: { operationId?: string; executionState: TaskState['executionHistory'][number]['state'] },
  expected: TaskState['executionHistory'][number]['state'],
): readonly string[] {
  return input.executionState === expected && input.operationId
    ? dedupeStrings([...current, input.operationId])
    : current;
}

function candidateToItem(
  candidate: MemoryCandidate,
  scope: ContextScope,
  defaultTtlMs: number | undefined,
): MemoryItem {
  const timestamp = now();
  const defaultExpiry = defaultTtlMs === undefined ? undefined : new Date(Date.now() + defaultTtlMs).toISOString();
  const candidateSource = sourceMetadata({
    id: `memory-candidate:${scope.applicationId ?? scope.conversationId}`,
    name: 'Application memory candidate',
    type: 'memory',
    sourceKind: 'MEMORY',
    authority: candidate.authority,
    observedAt: timestamp,
    scope: scope.namespaces,
  });
  return {
    id: id('memory'),
    type: candidate.type,
    layer: memoryLayer(candidate.type),
    scope: deepClone(scope),
    content: candidate.content.trim(),
    ...(candidate.structured === undefined ? {} : { structured: deepClone(candidate.structured) }),
    labels: [...(candidate.labels ?? [])],
    entities: [...(candidate.entities ?? [])],
    relevance: 0,
    confidence: clamp(candidate.confidence),
    authority: clamp(candidate.authority),
    durability: clamp(candidate.durability),
    usefulness: clamp(candidate.usefulness),
    privacy: candidate.privacy ?? 'internal',
    provenance: deepClone(
      candidate.provenance ?? provenance(candidateSource, 'received', 'memory-admission'),
    ),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(candidate.expiresAt === undefined && defaultExpiry === undefined
      ? {}
      : { expiresAt: candidate.expiresAt ?? defaultExpiry! }),
    version: 1,
    status: 'active',
  };
}

function memoryScore(item: MemoryItem, intent: NormalizedIntent, scope: ContextScope, current: number): number {
  const semantic = Math.max(lexicalSimilarity(item.content, intent.normalizedRequest), lexicalSimilarity(item.labels.join(' '), intent.keywords.join(' ')));
  const entity = intent.entities.length === 0
    ? 0.5
    : intent.entities.filter((entityValue) => item.entities.some((value) => value.toLowerCase() === entityValue.value.toLowerCase())).length / intent.entities.length;
  const recency = freshnessScore(item.updatedAt, 90 * 24 * 60 * 60 * 1_000, current);
  const scopeScore = scopeMatches(item.scope, scope) ? 1 : 0;
  return clamp(semantic * 0.35 + entity * 0.15 + recency * 0.1 + item.authority * 0.12 + item.confidence * 0.1 + item.usefulness * 0.08 + scopeScore * 0.1);
}

function memoryLayer(type: MemoryType): NonNullable<MemoryItem['layer']> {
  if (type === 'working') return 'working';
  if (type === 'short-term') return 'task';
  return 'long-term';
}

function scopeMatches(item: ContextScope, requested: ContextScope): boolean {
  if (item.tenantId && requested.tenantId && item.tenantId !== requested.tenantId) return false;
  if (item.applicationId && requested.applicationId && item.applicationId !== requested.applicationId) return false;
  if (item.userId && requested.userId && item.userId !== requested.userId) return false;
  if (item.namespaces.length && requested.namespaces.length && !item.namespaces.some((namespace) => requested.namespaces.includes(namespace))) return false;
  return true;
}

function isExpired(item: MemoryItem, current: number): boolean {
  return item.expiresAt !== undefined && Date.parse(item.expiresAt) <= current;
}

function lifecycleScore(item: MemoryItem): number {
  const active = item.status === 'active' ? 1 : 0;
  return active * 0.4 + item.usefulness * 0.2 + item.authority * 0.15 + item.confidence * 0.15 + item.durability * 0.1;
}

function contradictionHint(left: string, right: string): boolean {
  const negation = /\b(no|not|never|disabled|false|without|cannot|can't|mustn't)\b/i;
  return negation.test(left) !== negation.test(right) && lexicalSimilarity(left, right) >= 0.55;
}

function mergeMemory(left: string, right: string): string {
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left}\n${right}`;
}

function relatedGoal(left: string, right: string): boolean {
  return lexicalSimilarity(left, right) >= 0.3;
}

function initialSteps(intent: NormalizedIntent): TaskStep[] {
  const timestamp = now();
  const descriptions = intent.complexity === 'simple'
    ? ['Resolve the request with sufficient context']
    : ['Resolve intent and dependencies', 'Acquire and evaluate required evidence', 'Synthesize and finalize the response'];
  const ids = descriptions.map(() => id('step'));
  return descriptions.map((description, index) => ({
    id: ids[index]!,
    description,
    status: index === 0 ? 'in_progress' : 'pending',
    dependencies: index === 0 ? [] : [ids[index - 1]!],
    attempts: 0,
    evidenceIds: [],
    receiptIds: [],
    updatedAt: timestamp,
  }));
}

export function memoryFingerprint(item: MemoryItem): string {
  return stableHash({ type: item.type, scope: item.scope, content: item.content, structured: item.structured });
}

function dedupeMemory(items: readonly MemoryItem[]): MemoryItem[] {
  const output = new Map<string, MemoryItem>();
  for (const item of items) {
    const current = output.get(item.id);
    if (!current || item.version > current.version || item.updatedAt > current.updatedAt) {
      output.set(item.id, item);
    }
  }
  return [...output.values()];
}

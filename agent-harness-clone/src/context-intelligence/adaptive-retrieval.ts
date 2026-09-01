import type { ContextIntelligenceConfig } from './config.js';
import type {
  AdaptiveRetrievalSummary,
  ContextConflict,
  ContextNeed,
  EvidenceItem,
  RetrievalAdaptationStrategy,
  RetrievalAttemptAssessment,
  RetrievalEvidenceQuality,
  RetrievalNeedAssessment,
  RetrievalOutcomeClassification,
  RetrievalState,
  RetrievalTerminationReason,
  RuntimeRetrievalOperation,
  ToolObservation,
} from './contracts.js';
import { contextSourceKindForType } from './context-need.js';

/**
 * Evaluates completed runtime retrieval attempts and recommends the next kind of
 * change. It never executes tools or transforms queries itself.
 */
export class AdaptiveRetrievalIntelligence {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  evaluate(input: {
    requestId: string;
    needs: readonly ContextNeed[];
    operations: readonly RuntimeRetrievalOperation[];
    observations: readonly ToolObservation[];
    evaluatedEvidence: readonly EvidenceItem[];
    conflicts: readonly ContextConflict[];
    elapsedMs: number;
    /** Set after the planner has had an opportunity to materialize a recommendation. */
    planningComplete?: boolean;
  }): AdaptiveRetrievalSummary {
    const operations = input.operations.filter(
      (operation) => operation.requestId === input.requestId,
    );
    const observations = input.observations.filter(
      (observation) => observation.requestId === input.requestId,
    );
    const remainingRetrievalBudget = retrievalBudgetRemaining(
      operations,
      input.elapsedMs,
      this.config,
    );
    const attempts = assessAttempts({
      needs: input.needs,
      operations,
      observations,
      evidence: input.evaluatedEvidence,
      conflicts: input.conflicts,
      remainingRetrievalBudget,
    });
    const needAssessments = input.needs.map((need) =>
      assessNeed(
        need,
        attempts,
        remainingRetrievalBudget,
        operations,
        needHasUnresolvedConflict(need, input.evaluatedEvidence, input.conflicts),
      ),
    );
    const unresolvedNeeds = input.needs.filter((need) => {
      if (!need.required) return false;
      if (need.status !== 'satisfied') return true;
      return needAssessments.some(
        (assessment) => assessment.needId === need.id && assessment.outcome === 'SOURCE_CONFLICT',
      );
    });
    const terminationReason = summaryTerminationReason(
      unresolvedNeeds,
      needAssessments,
      remainingRetrievalBudget,
      Boolean(input.planningComplete),
      operations,
    );
    const state = summaryState(unresolvedNeeds, attempts, terminationReason);
    const overallEvidenceQuality = evidenceQuality(
      input.evaluatedEvidence,
      input.conflicts,
      unresolvedNeeds.length === 0,
    );

    return {
      state,
      attemptCount: operations.length,
      remainingRetrievalBudget,
      attempts: attempts.map((attempt, index) => ({
        ...attempt,
        ...(attempt.terminationReason !== undefined ||
        terminationReason === undefined ||
        index !== attempts.length - 1
          ? {}
          : { terminationReason }),
      })),
      needs: needAssessments.map((assessment) => ({
        ...assessment,
        ...(assessment.terminationReason !== undefined || terminationReason === undefined
          ? {}
          : { terminationReason }),
      })),
      evidenceQuality: overallEvidenceQuality,
      ...(terminationReason === undefined ? {} : { terminationReason }),
    };
  }
}

export function annotateRuntimeOperations(
  operations: RuntimeRetrievalOperation[],
  summary: AdaptiveRetrievalSummary,
): void {
  const assessments = new Map(summary.attempts.map((attempt) => [attempt.operationId, attempt]));
  for (const operation of operations) {
    const assessment = assessments.get(operation.id);
    if (!assessment) continue;
    operation.retrievalState = assessment.state;
    operation.remainingRetrievalBudget = assessment.remainingRetrievalBudget;
    operation.evidenceQuality = assessment.evidenceQuality;
    operation.contributedEvidence = assessment.contributedEvidence;
    if (assessment.outcome !== undefined) operation.retrievalResult = assessment.outcome;
    if (assessment.adaptationReason !== undefined) {
      operation.adaptationReason = assessment.adaptationReason;
    }
    if (assessment.previousStrategy !== undefined) {
      operation.previousStrategy = assessment.previousStrategy;
    }
    if (assessment.nextStrategy !== undefined) operation.nextStrategy = assessment.nextStrategy;
    if (assessment.terminationReason !== undefined) {
      operation.terminationReason = assessment.terminationReason;
    }
  }
}

type AttemptInput = {
  needs: readonly ContextNeed[];
  operations: readonly RuntimeRetrievalOperation[];
  observations: readonly ToolObservation[];
  evidence: readonly EvidenceItem[];
  conflicts: readonly ContextConflict[];
  remainingRetrievalBudget: number;
};

function assessAttempts(input: AttemptInput): RetrievalAttemptAssessment[] {
  return input.operations.map((operation, index) => {
    const need = input.needs.find((candidate) => candidate.id === operation.needId);
    const observation = input.observations.find(
      (candidate) => candidate.id === operation.observationId,
    );
    const relatedEvidence = input.evidence.filter(
      (item) => item.observationId === operation.observationId,
    );
    const prior = input.operations
      .slice(0, index)
      .filter((candidate) => candidate.needId === operation.needId)
      .at(-1);
    const next = input.operations
      .slice(index + 1)
      .find((candidate) => candidate.needId === operation.needId);
    const outcome = classifyAttempt({
      operation,
      observation,
      evidence: relatedEvidence,
      conflicts: input.conflicts,
      need,
      isLatestCompleted:
        input.operations
          .filter(
            (candidate) => candidate.needId === operation.needId && candidate.status !== 'planned',
          )
          .at(-1)?.id === operation.id,
    });
    const strategy = operation.strategy;
    const nextStrategy = next?.strategy;
    const state = attemptState(operation, prior !== undefined);
    const terminationReason = attemptTermination(outcome, next, input.remainingRetrievalBudget);
    return {
      operationId: operation.id,
      needId: operation.needId,
      attemptNumber: input.operations
        .slice(0, index + 1)
        .filter((candidate) => candidate.needId === operation.needId).length,
      state,
      capability: operation.capability,
      toolName: operation.toolName,
      strategy,
      ...(outcome === undefined ? {} : { outcome }),
      reason: attemptReason(operation, outcome),
      ...(operation.adaptationReason === undefined
        ? {}
        : { adaptationReason: operation.adaptationReason }),
      ...((operation.previousStrategy ?? prior?.strategy) === undefined
        ? {}
        : { previousStrategy: operation.previousStrategy ?? prior!.strategy }),
      ...(nextStrategy === undefined ? {} : { nextStrategy }),
      remainingRetrievalBudget: input.remainingRetrievalBudget,
      evidenceQuality: evidenceQuality(
        relatedEvidence,
        conflictsForEvidence(input.conflicts, relatedEvidence),
        outcome === 'RETRIEVAL_SUCCESS',
      ),
      contributedEvidence: relatedEvidence.some((item) => item.evaluation.admitted),
      ...(terminationReason === undefined ? {} : { terminationReason }),
    };
  });
}

function classifyAttempt(input: {
  operation: RuntimeRetrievalOperation;
  observation: ToolObservation | undefined;
  evidence: readonly EvidenceItem[];
  conflicts: readonly ContextConflict[];
  need: ContextNeed | undefined;
  isLatestCompleted: boolean;
}): RetrievalOutcomeClassification | undefined {
  const { operation, observation, evidence } = input;
  if (operation.status === 'planned') return undefined;
  if (operation.status === 'denied' || operation.failureClassification === 'authorization_denied') {
    return 'ACCESS_FAILURE';
  }
  if (operation.failureClassification === 'not_found') {
    return 'INVALID_REFERENCE';
  }
  if (operation.failureClassification === 'invalid_input') {
    return hasQueryLikeInput(operation.input) ? 'TOOL_FAILURE' : 'INVALID_REFERENCE';
  }
  if (operation.status === 'failed') return 'TOOL_FAILURE';
  if (operation.status === 'empty' || observation?.outcome === 'empty') return 'EMPTY_RESULT';
  if (!observation) return 'NO_RESULT';

  const relatedConflicts = conflictsForEvidence(input.conflicts, evidence);
  if (relatedConflicts.length > 0) return 'SOURCE_CONFLICT';
  if (
    evidence.some((item) =>
      item.evaluation.reasons.some((reason) => /freshness|stale/i.test(reason)),
    )
  ) {
    return 'STALE_EVIDENCE';
  }
  if (
    evidence.length > 0 &&
    evidence.every(
      (item) =>
        !item.evaluation.admitted &&
        item.evaluation.reasons.some((reason) => /relevance/i.test(reason)),
    )
  ) {
    return 'LOW_RELEVANCE';
  }
  if (evidence.some((item) => item.evaluation.admitted)) {
    return input.isLatestCompleted && input.need?.status === 'satisfied'
      ? 'RETRIEVAL_SUCCESS'
      : 'INSUFFICIENT_EVIDENCE';
  }
  if (operation.phase === 'discovery' || observation.outcome === 'partial') {
    return 'INSUFFICIENT_EVIDENCE';
  }
  return observation.content.trim().length === 0 ? 'NO_RESULT' : 'INSUFFICIENT_EVIDENCE';
}

function assessNeed(
  need: ContextNeed,
  attempts: readonly RetrievalAttemptAssessment[],
  remainingRetrievalBudget: number,
  operations: readonly RuntimeRetrievalOperation[],
  hasUnresolvedConflict: boolean,
): RetrievalNeedAssessment {
  const needAttempts = attempts.filter((attempt) => attempt.needId === need.id);
  const completed = needAttempts.filter((attempt) => attempt.outcome !== undefined);
  const latest = completed.at(-1);
  const planned = needAttempts.find((attempt) => attempt.outcome === undefined);
  if (need.status === 'clarification_required') {
    return {
      needId: need.id,
      state: 'BLOCKED',
      ...(latest?.outcome === undefined ? {} : { outcome: latest.outcome }),
      recommendedStrategies: [],
      terminationReason: 'CLARIFICATION_REQUIRED',
    };
  }
  if (need.status === 'unavailable') {
    return {
      needId: need.id,
      state: 'BLOCKED',
      ...(latest?.outcome === undefined ? {} : { outcome: latest.outcome }),
      recommendedStrategies: [],
      terminationReason: 'CAPABILITY_UNAVAILABLE',
    };
  }
  if (planned) {
    return {
      needId: need.id,
      state: completed.length > 0 ? 'RETRYING' : 'NOT_EXECUTED',
      ...(latest?.outcome === undefined ? {} : { outcome: latest.outcome }),
      recommendedStrategies: [planned.strategy],
      ...(planned.adaptationReason === undefined
        ? {}
        : { adaptationReason: planned.adaptationReason }),
    };
  }
  if (need.status === 'satisfied' && hasUnresolvedConflict) {
    const recommendedStrategies =
      remainingRetrievalBudget === 0 ? [] : recommendationFor('SOURCE_CONFLICT', undefined);
    return {
      needId: need.id,
      state: remainingRetrievalBudget === 0 ? 'EXHAUSTED' : 'FAILED',
      outcome: 'SOURCE_CONFLICT',
      recommendedStrategies,
      ...(recommendedStrategies.length === 0
        ? { terminationReason: 'UNRESOLVED_SOURCE_CONFLICT' as const }
        : { adaptationReason: adaptationReason('SOURCE_CONFLICT')! }),
    };
  }
  if (need.status === 'satisfied') {
    return {
      needId: need.id,
      state: 'SUCCESS',
      outcome: 'RETRIEVAL_SUCCESS',
      recommendedStrategies: [],
      terminationReason: 'SUFFICIENT_EVIDENCE',
    };
  }
  if (!latest) {
    return {
      needId: need.id,
      state: remainingRetrievalBudget === 0 ? 'EXHAUSTED' : 'NOT_EXECUTED',
      recommendedStrategies: remainingRetrievalBudget === 0 ? [] : ['INITIAL'],
      ...(remainingRetrievalBudget === 0
        ? { terminationReason: 'RETRIEVAL_BUDGET_EXHAUSTED' as const }
        : {}),
    };
  }
  const recommendedStrategies =
    remainingRetrievalBudget === 0
      ? []
      : recommendationFor(
          latest.outcome,
          operations.find((operation) => operation.id === latest.operationId),
        );
  const reason = adaptationReason(latest.outcome);
  return {
    needId: need.id,
    state: stateForOutcome(latest.outcome, remainingRetrievalBudget),
    ...(latest.outcome === undefined ? {} : { outcome: latest.outcome }),
    recommendedStrategies,
    ...(recommendedStrategies.length === 0 || reason === undefined
      ? {}
      : { adaptationReason: reason }),
    ...(latest.outcome === 'INVALID_REFERENCE'
      ? { terminationReason: 'INVALID_REFERENCE' as const }
      : latest.outcome === 'ACCESS_FAILURE' && recommendedStrategies.length === 0
        ? { terminationReason: 'ACCESS_BLOCKED' as const }
        : remainingRetrievalBudget === 0
          ? { terminationReason: 'RETRIEVAL_BUDGET_EXHAUSTED' as const }
          : {}),
  };
}

function recommendationFor(
  outcome: RetrievalOutcomeClassification | undefined,
  operation: RuntimeRetrievalOperation | undefined,
): RetrievalAdaptationStrategy[] {
  switch (outcome) {
    case undefined:
      return ['INITIAL'];
    case 'NO_RESULT':
    case 'EMPTY_RESULT':
      return ['RETRIEVAL_BROADEN', 'SOURCE_SWITCH', 'QUERY_REWRITE'];
    case 'LOW_RELEVANCE':
      return ['RETRIEVAL_NARROW', 'SOURCE_SWITCH', 'QUERY_REWRITE'];
    case 'INSUFFICIENT_EVIDENCE':
      return ['ADDITIONAL_EVIDENCE', 'SOURCE_SWITCH', 'QUERY_DECOMPOSITION'];
    case 'STALE_EVIDENCE':
      return ['SOURCE_SWITCH', 'ADDITIONAL_EVIDENCE'];
    case 'SOURCE_CONFLICT':
      return ['ADDITIONAL_EVIDENCE', 'SOURCE_SWITCH'];
    case 'TOOL_FAILURE':
      if (operation?.failureClassification === 'invalid_input' && hasQueryLikeInput(operation.input)) {
        // When the invalid input is caused by an oversized query, decomposition must
        // come first — rewrite alone can add terms and further lengthen the request.
        // The distinction is made by inspecting the failure content for size-related
        // language; if detection is inconclusive the strategies still cover both paths.
        return isOversizedQueryFailure(operation)
          ? ['QUERY_DECOMPOSITION', 'QUERY_REWRITE', 'SOURCE_SWITCH']
          : ['QUERY_REWRITE', 'QUERY_DECOMPOSITION', 'SOURCE_SWITCH'];
      }
      return isTransient(operation?.failureClassification)
        ? ['SOURCE_SWITCH', 'TRANSIENT_RETRY']
        : ['SOURCE_SWITCH'];
    case 'ACCESS_FAILURE':
      return ['SOURCE_SWITCH'];
    case 'INVALID_REFERENCE':
    case 'RETRIEVAL_SUCCESS':
      return [];
  }
}

function hasQueryLikeInput(input: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(input).some(
    ([name, value]) =>
      typeof value === 'string' &&
      /^(?:query|search|searchquery|term|question|text|prompt|filter)$/i.test(name),
  );
}

/**
 * Returns true when an invalid_input failure is likely caused by an oversized query
 * argument rather than a structural or type error.  Detection is based on the failure
 * classification metadata written by ObservationIntelligence from the tool's own error
 * text, and on the observable query size relative to common tool limits.  It never
 * fabricates a specific limit; it only detects size-related failure language.
 */
function isOversizedQueryFailure(operation: RuntimeRetrievalOperation): boolean {
  // Detect explicit size-language in the observation errors (written from the tool's
  // actual error message by ObservationIntelligence).
  const hasOversizeError = operation.failureClassification === 'invalid_input';
  if (!hasOversizeError) return false;
  // Inspect the query value: if it is unusually long it is a strong signal that
  // the tool rejected it for size, even when we cannot read the error text here.
  const queryValue = Object.entries(operation.input).find(
    ([name]) => /^(?:query|search|searchquery|term|question|text|prompt|filter)$/i.test(name),
  )?.[1];
  return typeof queryValue === 'string' && queryValue.length > 200;
}

function adaptationReason(outcome: RetrievalOutcomeClassification | undefined): string | undefined {
  switch (outcome) {
    case 'NO_RESULT':
    case 'EMPTY_RESULT':
      return 'The prior attempt returned no usable result; broaden or change the source.';
    case 'LOW_RELEVANCE':
      return 'The prior result was weakly related; narrow the request or change the source.';
    case 'INSUFFICIENT_EVIDENCE':
      return 'Useful evidence did not close the information need; seek complementary evidence.';
    case 'STALE_EVIDENCE':
      return 'The evidence did not satisfy the freshness requirement; prefer a fresher source.';
    case 'SOURCE_CONFLICT':
      return 'Conflicting claims require additional authoritative evidence.';
    case 'TOOL_FAILURE':
      return 'The capability failed; change source or capability before considering a bounded transient retry.';
    case 'ACCESS_FAILURE':
      return 'The attempted capability was inaccessible; use another permitted source or stop.';
    default:
      return undefined;
  }
}

function retrievalBudgetRemaining(
  operations: readonly RuntimeRetrievalOperation[],
  elapsedMs: number,
  config: ContextIntelligenceConfig,
): number {
  if (elapsedMs >= config.budgets.maxLoopMilliseconds) return 0;
  const iterations = operations.reduce(
    (maximum, operation) => Math.max(maximum, operation.iteration),
    0,
  );
  if (iterations >= config.budgets.maxRetrievalIterations) return 0;
  return Math.max(
    0,
    Math.min(
      config.budgets.maxRetrievalOperations - operations.length,
      config.budgets.maxToolActions - operations.length,
    ),
  );
}

function evidenceQuality(
  evidence: readonly EvidenceItem[],
  conflicts: readonly ContextConflict[],
  sufficient: boolean,
): RetrievalEvidenceQuality {
  const measured = evidence.filter((item) => item.evaluation !== undefined);
  return {
    evidenceCount: evidence.filter((item) => item.evaluation.admitted).length,
    ...(measured.length === 0
      ? {}
      : {
          relevance: average(measured.map((item) => item.evaluation.relevance)),
          authority: average(measured.map((item) => item.evaluation.authority)),
          freshness: average(measured.map((item) => item.evaluation.freshness)),
          confidence: average(measured.map((item) => item.evaluation.confidence)),
          provenanceCompleteness:
            measured.filter((item) => item.evaluation.provenanceComplete).length / measured.length,
        }),
    conflictCount: conflicts.length,
    sufficient,
  };
}

function conflictsForEvidence(
  conflicts: readonly ContextConflict[],
  evidence: readonly EvidenceItem[],
): ContextConflict[] {
  const ids = new Set(
    evidence.flatMap((item) => [item.id, item.observationId ?? '', item.retrievalResultId ?? '']),
  );
  return conflicts.filter(
    (conflict) =>
      conflict.resolution === 'unresolved' && conflict.itemIds.some((itemId) => ids.has(itemId)),
  );
}

function needHasUnresolvedConflict(
  need: ContextNeed,
  evidence: readonly EvidenceItem[],
  conflicts: readonly ContextConflict[],
): boolean {
  const related = evidence.filter((item) => {
    const sourceKind = item.source.sourceKind ?? contextSourceKindForType(item.source.type);
    return need.sourceKinds.includes(sourceKind);
  });
  return conflictsForEvidence(conflicts, related).length > 0;
}

function attemptState(operation: RuntimeRetrievalOperation, hasPrior: boolean): RetrievalState {
  if (operation.status === 'planned') return hasPrior ? 'RETRYING' : 'NOT_EXECUTED';
  if (operation.status === 'succeeded') return 'SUCCESS';
  if (operation.status === 'empty') return 'EMPTY';
  if (operation.status === 'denied') return 'BLOCKED';
  return 'FAILED';
}

function stateForOutcome(
  outcome: RetrievalOutcomeClassification | undefined,
  remainingRetrievalBudget: number,
): RetrievalState {
  if (remainingRetrievalBudget === 0) return 'EXHAUSTED';
  if (outcome === 'RETRIEVAL_SUCCESS') return 'SUCCESS';
  if (outcome === 'EMPTY_RESULT' || outcome === 'NO_RESULT') return 'EMPTY';
  if (outcome === 'ACCESS_FAILURE' || outcome === 'INVALID_REFERENCE') return 'BLOCKED';
  return 'FAILED';
}

function summaryState(
  missing: readonly ContextNeed[],
  attempts: readonly RetrievalAttemptAssessment[],
  terminationReason: RetrievalTerminationReason | undefined,
): RetrievalState {
  if (missing.length === 0) return 'SUCCESS';
  if (terminationReason === 'RETRIEVAL_BUDGET_EXHAUSTED') return 'EXHAUSTED';
  if (
    terminationReason === 'CLARIFICATION_REQUIRED' ||
    terminationReason === 'CAPABILITY_UNAVAILABLE' ||
    terminationReason === 'ACCESS_BLOCKED' ||
    terminationReason === 'INVALID_REFERENCE'
  ) {
    return 'BLOCKED';
  }
  if (attempts.some((attempt) => attempt.state === 'RETRYING')) return 'RETRYING';
  if (attempts.some((attempt) => attempt.state === 'NOT_EXECUTED')) return 'NOT_EXECUTED';
  if (attempts.some((attempt) => attempt.state === 'FAILED')) return 'FAILED';
  if (attempts.some((attempt) => attempt.state === 'EMPTY')) return 'EMPTY';
  return 'NOT_EXECUTED';
}

function summaryTerminationReason(
  missing: readonly ContextNeed[],
  assessments: readonly RetrievalNeedAssessment[],
  remainingRetrievalBudget: number,
  planningComplete: boolean,
  operations: readonly RuntimeRetrievalOperation[],
): RetrievalTerminationReason | undefined {
  if (missing.length === 0) return 'SUFFICIENT_EVIDENCE';
  const hasPlanned = operations.some((operation) => operation.status === 'planned');
  if (hasPlanned) return undefined;
  const missingIds = new Set(missing.map((need) => need.id));
  const explicit = assessments.find(
    (assessment) => missingIds.has(assessment.needId) && assessment.terminationReason !== undefined,
  )?.terminationReason;
  if (explicit !== undefined) return explicit;
  if (remainingRetrievalBudget === 0) return 'RETRIEVAL_BUDGET_EXHAUSTED';
  if (!planningComplete) return undefined;
  const latestOutcomes = assessments.map((assessment) => assessment.outcome);
  if (latestOutcomes.includes('ACCESS_FAILURE')) return 'ACCESS_BLOCKED';
  if (latestOutcomes.includes('INVALID_REFERENCE')) return 'INVALID_REFERENCE';
  if (latestOutcomes.includes('SOURCE_CONFLICT')) return 'UNRESOLVED_SOURCE_CONFLICT';
  return 'NO_USEFUL_ADAPTATION';
}

function attemptTermination(
  outcome: RetrievalOutcomeClassification | undefined,
  next: RuntimeRetrievalOperation | undefined,
  remainingRetrievalBudget: number,
): RetrievalTerminationReason | undefined {
  if (outcome === 'RETRIEVAL_SUCCESS') return 'SUFFICIENT_EVIDENCE';
  if (outcome === 'INVALID_REFERENCE') return 'INVALID_REFERENCE';
  if (next) return undefined;
  if (remainingRetrievalBudget === 0) return 'RETRIEVAL_BUDGET_EXHAUSTED';
  return undefined;
}

function attemptReason(
  operation: RuntimeRetrievalOperation,
  outcome: RetrievalOutcomeClassification | undefined,
): string {
  if (operation.status === 'planned')
    return 'The retrieval attempt is planned and has not executed.';
  if (outcome === undefined) return `The operation ended as ${operation.status}.`;
  return `The retrieval attempt was classified as ${outcome}.`;
}

function isTransient(classification: RuntimeRetrievalOperation['failureClassification']): boolean {
  return (
    classification === 'timeout' ||
    classification === 'network' ||
    classification === 'rate_limited'
  );
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

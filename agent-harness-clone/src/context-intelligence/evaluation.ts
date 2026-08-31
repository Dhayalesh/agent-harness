import type {
  ContextEvaluationSnapshot,
  ContextFeedbackRecord,
  ContextRuntimeDirective,
  EvidenceItem,
  FinalizedContext,
  MeasuredRatio,
  MemoryRecallAssessment,
  RuntimeRetrievalOperation,
} from './contracts.js';
import { now } from './utils.js';

/** Computes only ratios with observed denominators; no proxy is labeled recall or accuracy. */
export class ContextEvaluationIntelligence {
  constructor(private readonly maximumOperations = 200) {}

  evaluate(input: {
    requestId: string;
    operations: readonly RuntimeRetrievalOperation[];
    feedback: readonly ContextFeedbackRecord[];
    evidence: readonly EvidenceItem[];
    finalized: FinalizedContext;
    memoryAssessment: MemoryRecallAssessment;
    directive: ContextRuntimeDirective;
  }): ContextEvaluationSnapshot {
    const terminalOperations = input.operations
      .filter(
        (operation) =>
          operation.requestId === input.requestId && operation.status !== 'planned',
      )
      .slice(-this.maximumOperations);
    const terminalOperationIds = new Set(terminalOperations.map((operation) => operation.id));
    const operationFeedback = input.feedback.filter(
      (record) =>
        record.requestId === input.requestId &&
        record.operationId !== undefined &&
        terminalOperationIds.has(record.operationId),
    );
    const classifiedOperationIds = new Set(
      operationFeedback
        .filter((record) =>
          ['useful', 'irrelevant', 'failed', 'duplicate'].includes(record.outcome),
        )
        .map((record) => record.operationId!),
    );
    const usefulOperationIds = new Set(
      operationFeedback
        .filter((record) => record.outcome === 'useful')
        .map((record) => record.operationId!),
    );
    const activeIds = new Set(input.finalized.activeItemIds);
    const usedEvidence = input.evidence.filter((evidence) => activeIds.has(evidence.id)).length;
    const memoryDenominator =
      input.memoryAssessment.retained.length + input.memoryAssessment.ignoredIds.length;
    const terminalGate =
      input.directive.decision !== 'RETRIEVE' && input.directive.decision !== 'RETRIEVE_AGAIN';
    const durations = terminalOperations
      .map((operation) => operation.executionDurationMs ?? operation.durationMs)
      .filter((duration): duration is number =>
        duration !== undefined && Number.isFinite(duration) && duration >= 0,
      );
    const costs = costGroups(terminalOperations);
    const unavailable: ContextEvaluationSnapshot['unavailable'][number][] = [
      { metric: 'retrieval_recall', reason: 'no_relevance_ground_truth' },
      { metric: 'answer_accuracy', reason: 'no_accuracy_ground_truth' },
      ...(costs.length === 0
        ? ([{ metric: 'observed_cost', reason: 'no_observed_cost' }] as const)
        : []),
    ];
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    return {
      ...(ratio(
        terminalOperations.filter((operation) => operation.status === 'succeeded').length,
        terminalOperations.length,
      ) === undefined
        ? {}
        : {
            operationSuccess: ratio(
              terminalOperations.filter((operation) => operation.status === 'succeeded').length,
              terminalOperations.length,
            )!,
          }),
      ...(ratio(usefulOperationIds.size, classifiedOperationIds.size) === undefined
        ? {}
        : {
            classifiedRetrievalUsefulness: ratio(
              usefulOperationIds.size,
              classifiedOperationIds.size,
            )!,
          }),
      ...(ratio(usedEvidence, input.evidence.length) === undefined
        ? {}
        : { evidenceUtilization: ratio(usedEvidence, input.evidence.length)! }),
      ...(ratio(input.memoryAssessment.retained.length, memoryDenominator) === undefined
        ? {}
        : {
            memoryRetention: ratio(
              input.memoryAssessment.retained.length,
              memoryDenominator,
            )!,
          }),
      ...(terminalGate
        ? { gateRejection: ratio(input.directive.continueToModel ? 0 : 1, 1)! }
        : {}),
      unclassifiedRetrievalOperations: terminalOperations.filter(
        (operation) => !classifiedOperationIds.has(operation.id),
      ).length,
      latency: {
        samples: durations.length,
        totalMs: totalDuration,
        ...(durations.length === 0
          ? {}
          : {
              meanMs: totalDuration / durations.length,
              minimumMs: Math.min(...durations),
              maximumMs: Math.max(...durations),
            }),
      },
      costs,
      unavailable,
      evaluatedAt: now(),
    };
  }
}

function ratio(numerator: number, denominator: number): MeasuredRatio | undefined {
  if (denominator <= 0) return undefined;
  return { numerator, denominator, value: numerator / denominator };
}

function costGroups(
  operations: readonly RuntimeRetrievalOperation[],
): ContextEvaluationSnapshot['costs'] {
  const groups = new Map<string, { unit: string; samples: number; total: number }>();
  for (const operation of operations) {
    const cost = operation.observedCost;
    if (!cost || !Number.isFinite(cost.amount) || cost.amount < 0 || !cost.unit.trim()) continue;
    const unit = cost.unit.trim().toLowerCase().slice(0, 50);
    const existing = groups.get(unit) ?? { unit, samples: 0, total: 0 };
    existing.samples += 1;
    existing.total += cost.amount;
    groups.set(unit, existing);
  }
  return [...groups.values()].slice(0, 20);
}

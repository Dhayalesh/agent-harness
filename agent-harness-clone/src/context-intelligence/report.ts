import type {
  ContextContract,
  ContextIntelligenceAttemptTrace,
  ContextIntelligenceProvenanceTrace,
  ContextIntelligenceReport,
  ContextNeedType,
  MemoryType,
  QueryVariant,
  RetrievalOutcomeClassification,
  ToolOutcome,
} from './contracts.js';

/** Keep name-bearing telemetry useful without letting a very large catalogue grow a frame. */
const NAME_LIMIT = 50;

/**
 * Projects a rich Context Contract into application telemetry. Aggregate fields
 * stay bounded, while the local Console trace carries exact runtime-owned attempt
 * inputs/results and grounding references. No value is reconstructed from a plan.
 */
export function contextIntelligenceReport(contract: ContextContract): ContextIntelligenceReport {
  const providerNames = unique(contract.retrieval.results.map((result) => result.providerId));
  const selectedNames = unique(contract.capabilities.map((entry) => entry.capability.name));
  const finalContext = contract.finalContext;
  const runtimeIterations = new Set(
    contract.runtimeRetrieval.map((operation) => operation.iteration),
  ).size;
  const successfulRuntimeResults = contract.runtimeRetrieval.filter(
    (operation) =>
      operation.phase === 'retrieval' &&
      operation.status === 'succeeded' &&
      operation.executionState === 'SUCCESS' &&
      operation.actualResult !== undefined,
  ).length;
  const attempts = contract.runtimeRetrieval.map((operation) =>
    attemptTrace(contract, operation.id),
  );
  const adaptedAttempts = attempts.filter((attempt) => attempt.attemptNumber > 1);
  const latestAdaptation = [...adaptedAttempts]
    .reverse()
    .find((attempt) => attempt.adaptationReason !== undefined);
  const provenanceTrace = runtimeProvenanceTrace(contract, attempts);

  return {
    version: 1,
    requestId: contract.requestId,
    intent: {
      operation: contract.intent.operation,
      complexity: contract.intent.complexity,
      confidence: contract.intent.confidence,
      constraints: contract.constraints.length,
      requiredEntities: contract.requiredEntities.length,
      ambiguities: contract.intent.ambiguity.length,
    },
    contextNeeds: {
      total: contract.contextNeeds.length,
      required: contract.contextNeeds.filter((need) => need.required).length,
      missing: contract.contextNeeds.filter((need) => need.status === 'missing').length,
      unavailable: contract.contextNeeds.filter((need) => need.status === 'unavailable').length,
      clarificationRequired: contract.contextNeeds.filter(
        (need) => need.status === 'clarification_required',
      ).length,
      types: countBy<ContextNeedType>(contract.contextNeeds.map((need) => need.type)),
      capabilities: unique(contract.contextNeeds.map((need) => need.requiredCapability)).slice(
        0,
        NAME_LIMIT,
      ),
    },
    query: {
      variants: contract.queryPlan.variants.length,
      transformations: countBy<QueryVariant['kind']>(
        contract.queryPlan.variants.map((variant) => variant.kind),
      ),
    },
    retrieval: {
      providers: providerNames.slice(0, NAME_LIMIT),
      providerCount: providerNames.length,
      iterations: contract.retrieval.iterations.length + runtimeIterations,
      results: contract.retrieval.results.length + successfulRuntimeResults,
      sufficient: contract.retrieval.sufficient,
      insufficiencies: contract.retrieval.insufficiencies.length,
      conflicts: contract.retrieval.conflicts.length,
      operations: contract.runtimeRetrieval.length,
      operationOutcomes: countBy(contract.runtimeRetrieval.map((operation) => operation.status)),
      executionStates: countBy(
        contract.runtimeRetrieval.map((operation) => operation.executionState),
      ),
      resourceStates: countBy(contract.resources.map((resource) => resource.state)),
      toolNames: unique(contract.runtimeRetrieval.map((operation) => operation.toolName)).slice(
        0,
        NAME_LIMIT,
      ),
      attempts,
      adaptive: {
        state: contract.adaptiveRetrieval.state,
        attemptCount: contract.adaptiveRetrieval.attemptCount,
        remainingBudget: contract.adaptiveRetrieval.remainingRetrievalBudget,
        strategies: countBy(contract.adaptiveRetrieval.attempts.map((attempt) => attempt.strategy)),
        outcomes: countBy(
          contract.adaptiveRetrieval.attempts
            .map((attempt) => attempt.outcome)
            .filter((outcome): outcome is RetrievalOutcomeClassification => outcome !== undefined),
        ),
        evidenceQuality: structuredClone(contract.adaptiveRetrieval.evidenceQuality),
        triggered: adaptedAttempts.length > 0,
        ...(latestAdaptation?.adaptationReason === undefined
          ? {}
          : { reason: latestAdaptation.adaptationReason }),
        ...(adaptedAttempts.length === 0
          ? {}
          : {
              evidenceGap:
                attempts.find((attempt) => attempt.attemptNumber === 1)?.classification ??
                'NOT_EXPOSED',
              meaningfulStrategyChange: adaptedAttempts.some(
                (attempt) => attempt.strategyChange?.meaningful === true,
              ),
            }),
        ...(contract.adaptiveRetrieval.terminationReason === undefined
          ? {}
          : { terminationReason: contract.adaptiveRetrieval.terminationReason }),
      },
    },
    trace: {
      informationNeeds: contract.contextNeeds.flatMap((need) =>
        need.normalizedRetrievalRequest === undefined
          ? []
          : [
              {
                needId: need.id,
                informationNeed: need.normalizedRetrievalRequest.informationNeed,
                normalizedRequest: need.normalizedRetrievalRequest.request,
                capability: need.requiredCapability,
              },
            ],
      ),
      provenance: provenanceTrace,
    },
    grounding: structuredClone(contract.grounding),
    memory: {
      recalled: contract.memories.length,
      types: countBy<MemoryType>(contract.memories.map((memory) => memory.type)),
      reconciliation: {
        retained: contract.memoryAssessment.retained.length,
        ignored: contract.memoryAssessment.ignoredIds.length,
        stale: contract.memoryAssessment.staleIds.length,
        conflicts: contract.memoryAssessment.conflictingIds.length,
      },
    },
    lifecycle: {
      events: contract.lifecycle.length,
      states: countBy(contract.lifecycle.map((event) => event.to)),
    },
    capabilities: {
      available: contract.toolPlan.selected.length + contract.toolPlan.excluded.length,
      selected: contract.toolPlan.selected.length,
      excluded: contract.toolPlan.excluded.length,
      names: selectedNames.slice(0, NAME_LIMIT),
    },
    observations: {
      total: contract.observations.length,
      outcomes: countBy<ToolOutcome>(
        contract.observations.map((observation) => observation.outcome),
      ),
      facts: sum(contract.observations.map((observation) => observation.facts.length)),
      identifiers: sum(contract.observations.map((observation) => observation.identifiers.length)),
      followUps: contract.observations.filter((observation) => observation.requiresFollowUp).length,
      offloaded: contract.observations.filter((observation) => observation.artifactId !== undefined)
        .length,
    },
    task: {
      status: contract.taskState.status,
      steps: contract.taskState.plan.length,
      completed: contract.taskState.completedSteps.length,
      pending: contract.taskState.pendingSteps.length,
      retries: contract.taskState.retries,
      unresolvedIssues: contract.taskState.unresolvedIssues.length,
      pendingDecisions: contract.pendingDecisions.length,
    },
    quality: {
      status: contract.quality.status,
      decision: contract.quality.decision,
      score: contract.quality.score,
      sufficient: contract.quality.sufficient,
      conflicts: contract.quality.conflicts.length,
      issues: summarizeQualityIssues(contract),
    },
    budget: structuredClone(contract.budget),
    finalContext: {
      items: contract.items.length,
      canonicalItems: finalContext?.canonicalItemIds.length ?? contract.items.length,
      activeItems:
        finalContext?.activeItemIds.length ?? contract.items.filter((item) => item.active).length,
      evidence: contract.evidence.length,
      sources: contract.sources.length,
      sections: finalContext?.sections.length ?? 0,
      tools: finalContext?.tools.length ?? contract.capabilities.length,
      omittedItems: finalContext?.omittedItemIds.length ?? 0,
      omittedMessages: finalContext?.omittedMessageIds.length ?? 0,
      offloadedArtifacts: contract.offloadedArtifacts.length,
      provenanceRecords: contract.provenance.length,
    },
    intervention: {
      required: !contract.directive.continueToModel,
      continueToModel: contract.directive.continueToModel,
      decision: contract.directive.decision,
      reasonCodes: contract.directive.reasonCodes.slice(0, NAME_LIMIT),
      clarificationNeeds: contract.directive.clarification
        .map((entry) => entry.type)
        .slice(0, NAME_LIMIT),
    },
    reasoning: {
      mode: contract.reasoning.mode,
      alternatives: contract.reasoning.alternatives.length,
      planSteps: contract.reasoning.plan.length,
    },
    ...(contract.feedback === undefined
      ? {}
      : {
          feedback: {
            total: contract.feedback.length,
            categories: countBy(contract.feedback.map((record) => record.category)),
            outcomes: countBy(contract.feedback.map((record) => record.outcome)),
          },
        }),
    ...(contract.predictiveContext === undefined
      ? {}
      : {
          prediction: {
            hints: contract.predictiveContext.readyStepIds.length,
            satisfiedDependencies: contract.predictiveContext.satisfiedDependencyIds.length,
            evidenceReferences: contract.predictiveContext.evidenceIds.length,
            truncated: contract.predictiveContext.truncated,
          },
        }),
    ...(contract.optimization === undefined
      ? {}
      : { optimization: structuredClone(contract.optimization) }),
    ...(contract.evaluation === undefined
      ? {}
      : { evaluation: structuredClone(contract.evaluation) }),
    updatedAt: contract.updatedAt,
  };
}

function attemptTrace(
  contract: ContextContract,
  operationId: string,
): ContextIntelligenceAttemptTrace {
  const operation = contract.runtimeRetrieval.find((candidate) => candidate.id === operationId)!;
  const assessment = contract.adaptiveRetrieval.attempts.find(
    (candidate) => candidate.operationId === operation.id,
  );
  const observation = contract.observations.find(
    (candidate) => candidate.id === operation.observationId,
  );
  const evidence = contract.evidence.filter(
    (candidate) => candidate.observationId === operation.observationId,
  );
  return {
    attemptId: operation.id,
    retrievalPlanId: operation.retrievalPlanId,
    attemptNumber: assessment?.attemptNumber ?? operation.iteration,
    needId: operation.needId,
    ...(operation.retrievalInput?.informationNeed === undefined
      ? {}
      : { informationNeed: operation.retrievalInput.informationNeed }),
    ...(operation.retrievalInput?.retrievalRequest === undefined
      ? {}
      : { normalizedRequest: operation.retrievalInput.retrievalRequest }),
    capability: operation.capability,
    toolName: operation.toolName,
    strategy: operation.strategy,
    plannedToolInput: structuredClone(operation.input),
    ...(operation.actualInput === undefined
      ? {}
      : { actualToolInput: structuredClone(operation.actualInput) }),
    ...(operation.actualResult === undefined
      ? {}
      : { actualToolResult: structuredClone(operation.actualResult) }),
    ...(operation.invokedAt === undefined ? {} : { invokedAt: operation.invokedAt }),
    ...(operation.resultReceivedAt === undefined
      ? {}
      : { resultReceivedAt: operation.resultReceivedAt }),
    executionState: operation.executionState,
    ...(operation.retrievalState === undefined ? {} : { retrievalState: operation.retrievalState }),
    ...(observation === undefined
      ? {}
      : {
          observation: {
            observationId: observation.id,
            outcome: observation.outcome,
            content: observation.content,
            ...(observation.structured === undefined
              ? {}
              : { structured: structuredClone(observation.structured) }),
            source: structuredClone(observation.source),
            provenanceId: observation.provenance.id,
          },
        }),
    ...(assessment?.outcome === undefined ? {} : { classification: assessment.outcome }),
    evidence: evidence.map((item) => ({
      evidenceId: item.id,
      ...(item.observationId === undefined ? {} : { observationId: item.observationId }),
      provenanceId: item.provenance.id,
      source: structuredClone(item.source),
      admitted: item.evaluation.admitted,
    })),
    ...(assessment?.evidenceQuality === undefined
      ? operation.evidenceQuality === undefined
        ? {}
        : { evidenceQuality: structuredClone(operation.evidenceQuality) }
      : { evidenceQuality: structuredClone(assessment.evidenceQuality) }),
    sufficient: assessment?.outcome === 'RETRIEVAL_SUCCESS',
    ...(operation.adaptationReason === undefined
      ? {}
      : { adaptationReason: operation.adaptationReason }),
    ...(operation.previousStrategy === undefined
      ? {}
      : { previousStrategy: operation.previousStrategy }),
    ...(operation.nextStrategy === undefined ? {} : { nextStrategy: operation.nextStrategy }),
    ...(operation.strategyChange === undefined
      ? {}
      : { strategyChange: structuredClone(operation.strategyChange) }),
    ...(operation.sourceLineage === undefined
      ? {}
      : { sourceLineage: structuredClone(operation.sourceLineage) }),
    ...(operation.remainingRetrievalBudget === undefined
      ? {}
      : { remainingBudget: operation.remainingRetrievalBudget }),
    ...(operation.terminationReason === undefined
      ? {}
      : { terminationReason: operation.terminationReason }),
  };
}

function runtimeProvenanceTrace(
  contract: ContextContract,
  attempts: readonly ContextIntelligenceAttemptTrace[],
): ContextIntelligenceProvenanceTrace {
  const stages: ContextIntelligenceProvenanceTrace['stages'][number][] = [
    { stage: 'REQUEST', objectId: contract.requestId, parentIds: [] },
  ];
  for (const need of contract.contextNeeds) {
    stages.push({ stage: 'INFORMATION_NEED', objectId: need.id, parentIds: [contract.requestId] });
    if (need.normalizedRetrievalRequest) {
      stages.push({
        stage: 'NORMALIZED_REQUEST',
        objectId: `normalized:${need.id}`,
        parentIds: [need.id],
      });
    }
  }
  for (const attempt of attempts) {
    stages.push({
      stage: 'RETRIEVAL_PLAN',
      objectId: attempt.retrievalPlanId,
      parentIds: [`normalized:${attempt.needId}`],
    });
    stages.push({
      stage: 'CAPABILITY',
      objectId: `${attempt.attemptId}:${attempt.toolName}`,
      parentIds: [attempt.retrievalPlanId],
    });
    if (attempt.actualToolInput !== undefined) {
      stages.push({
        stage: 'TOOL_INPUT',
        objectId: `actual-input:${attempt.attemptId}`,
        parentIds: [attempt.retrievalPlanId],
      });
    }
    if (attempt.observation) {
      stages.push({
        stage: 'OBSERVATION',
        objectId: attempt.observation.observationId,
        parentIds: [attempt.attemptId],
      });
    }
    for (const evidence of attempt.evidence) {
      stages.push({
        stage: 'EVIDENCE_EVALUATION',
        objectId: evidence.evidenceId,
        parentIds: evidence.observationId ? [evidence.observationId] : [],
      });
    }
    if (attempt.classification) {
      stages.push({
        stage: 'CLASSIFICATION',
        objectId: `${attempt.attemptId}:${attempt.classification}`,
        parentIds: attempt.observation ? [attempt.observation.observationId] : [attempt.attemptId],
      });
    }
    if (attempt.attemptNumber > 1) {
      stages.push({
        stage: 'ADAPTATION',
        objectId: `adaptation:${attempt.attemptId}`,
        parentIds: attempt.strategyChange
          ? [attempt.strategyChange.previousOperationId, attempt.retrievalPlanId]
          : [attempt.retrievalPlanId],
      });
    }
  }
  if (contract.grounding.status !== 'NOT_EVALUATED') {
    stages.push({
      stage: 'GROUNDING',
      objectId: `grounding:${contract.requestId}`,
      parentIds: contract.grounding.supportingEvidenceReferences.map(
        (reference) => reference.evidenceId,
      ),
    });
  }
  stages.push({
    stage: 'DECISION',
    objectId: `decision:${contract.requestId}:${contract.directive.decision}`,
    parentIds:
      contract.grounding.status === 'NOT_EVALUATED'
        ? attempts.map((attempt) => attempt.attemptId)
        : [`grounding:${contract.requestId}`],
  });

  const inconsistentSuccess = attempts.some(
    (attempt) =>
      attempt.executionState === 'SUCCESS' &&
      (attempt.actualToolInput === undefined ||
        attempt.actualToolResult === undefined ||
        attempt.observation === undefined),
  );
  const requiredRetrieval = contract.contextNeeds.some(
    (need) => need.required && need.evidenceRequirement === 'REQUIRED',
  );
  const incomplete =
    (requiredRetrieval && attempts.length === 0) ||
    attempts.some(
      (attempt) =>
        attempt.executionState === 'NOT_EXECUTED' ||
        (attempt.executionState === 'SUCCESS' && attempt.classification === undefined),
    ) ||
    contract.grounding.status === 'NOT_EVALUATED';
  return {
    status: inconsistentSuccess ? 'FAIL' : incomplete ? 'PARTIAL' : 'PASS',
    stages,
  };
}

function summarizeQualityIssues(
  contract: ContextContract,
): ContextIntelligenceReport['quality']['issues'] {
  const summaries = new Map<string, ContextIntelligenceReport['quality']['issues'][number]>();
  for (const issue of contract.quality.issues) {
    const key = `${issue.code}:${issue.severity}:${issue.remediation}`;
    const existing = summaries.get(key);
    summaries.set(key, {
      code: issue.code,
      severity: issue.severity,
      remediation: issue.remediation,
      items: (existing?.items ?? 0) + issue.itemIds.length,
    });
  }
  return [...summaries.values()];
}

function unique<Value extends string>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}

function countBy<Key extends string>(values: readonly Key[]): Record<Key, number> {
  const counts = {} as Record<Key, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

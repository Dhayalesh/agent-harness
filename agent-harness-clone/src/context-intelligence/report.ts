import type {
  ContextContract,
  ContextIntelligenceReport,
  ContextNeedType,
  MemoryType,
  QueryVariant,
  ToolOutcome,
} from './contracts.js';

/** Keep name-bearing telemetry useful without letting a very large catalogue grow a frame. */
const NAME_LIMIT = 50;

/**
 * Projects a rich Context Contract into the stable application/wire report.
 *
 * No raw request, item content, memory, evidence, observation content, identifiers,
 * or task text crosses this boundary. The report is deterministic and small enough
 * to emit once per model turn and persist on a run record.
 */
export function contextIntelligenceReport(contract: ContextContract): ContextIntelligenceReport {
  const providerNames = unique(contract.retrieval.results.map((result) => result.providerId));
  const selectedNames = unique(contract.capabilities.map((entry) => entry.capability.name));
  const finalContext = contract.finalContext;
  const runtimeIterations = new Set(
    contract.runtimeRetrieval.map((operation) => operation.iteration),
  ).size;
  const successfulRuntimeResults = contract.runtimeRetrieval.filter(
    (operation) => operation.phase === 'retrieval' && operation.status === 'succeeded',
  ).length;

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
      operationOutcomes: countBy(
        contract.runtimeRetrieval.map((operation) => operation.status),
      ),
      executionStates: countBy(
        contract.runtimeRetrieval.map((operation) => operation.executionState),
      ),
      resourceStates: countBy(contract.resources.map((resource) => resource.state)),
      toolNames: unique(contract.runtimeRetrieval.map((operation) => operation.toolName)).slice(
        0,
        NAME_LIMIT,
      ),
    },
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
            satisfiedDependencies:
              contract.predictiveContext.satisfiedDependencyIds.length,
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

import type {
  ContextContract,
  ContextIntelligenceReport,
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
    query: {
      variants: contract.queryPlan.variants.length,
      transformations: countBy<QueryVariant['kind']>(
        contract.queryPlan.variants.map((variant) => variant.kind),
      ),
    },
    retrieval: {
      providers: providerNames.slice(0, NAME_LIMIT),
      providerCount: providerNames.length,
      iterations: contract.retrieval.iterations.length,
      results: contract.retrieval.results.length,
      sufficient: contract.retrieval.sufficient,
      insufficiencies: contract.retrieval.insufficiencies.length,
      conflicts: contract.retrieval.conflicts.length,
    },
    memory: {
      recalled: contract.memories.length,
      types: countBy<MemoryType>(contract.memories.map((memory) => memory.type)),
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
      score: contract.quality.score,
      sufficient: contract.quality.sufficient,
      conflicts: contract.quality.conflicts.length,
      issues: summarizeQualityIssues(contract),
    },
    budget: structuredClone(contract.budget),
    finalContext: {
      items: contract.items.length,
      evidence: contract.evidence.length,
      sources: contract.sources.length,
      sections: finalContext?.sections.length ?? 0,
      tools: finalContext?.tools.length ?? contract.capabilities.length,
      omittedItems: finalContext?.omittedItemIds.length ?? 0,
      offloadedArtifacts: contract.offloadedArtifacts.length,
      provenanceRecords: contract.provenance.length,
    },
    reasoning: {
      mode: contract.reasoning.mode,
      alternatives: contract.reasoning.alternatives.length,
      planSteps: contract.reasoning.plan.length,
    },
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

function unique(values: readonly string[]): string[] {
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

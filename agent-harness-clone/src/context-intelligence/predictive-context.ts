import type {
  ContextItem,
  PredictiveContextProjection,
  TaskState,
} from './contracts.js';
import {
  dedupeStrings,
  estimateTokens,
  now,
  provenance,
  sourceMetadata,
  stableHash,
} from './utils.js';

/**
 * Projects only dependency-ready task planning context. It has no access to query,
 * retrieval, provider, or tool-planning APIs, so it cannot initiate speculative
 * acquisition or manufacture evidence.
 */
export class PredictiveContextIntelligence {
  private readonly maximumEvidenceReferences: number;
  private readonly maximumDependencyReferences: number;

  constructor(
    private readonly maximumHints = 8,
    maximumEvidenceReferences = Math.max(8, maximumHints * 8),
    maximumDependencyReferences = Math.max(8, maximumHints * 8),
  ) {
    this.maximumEvidenceReferences = maximumEvidenceReferences;
    this.maximumDependencyReferences = maximumDependencyReferences;
  }

  project(
    taskState: TaskState,
    currentEvidenceIds: ReadonlySet<string>,
  ): { projection: PredictiveContextProjection; item?: ContextItem } {
    const candidates = taskState.dependencies
      .filter((dependency) => dependency.status === 'ready')
      .map((dependency) => ({
        dependency,
        step: taskState.plan.find((step) => step.id === dependency.id),
      }))
      .filter(
        (entry): entry is {
          dependency: TaskState['dependencies'][number];
          step: TaskState['plan'][number];
        } =>
          entry.step !== undefined &&
          (entry.step.status === 'pending' || entry.step.status === 'in_progress') &&
          entry.dependency.dependsOn.every((id) => taskState.completedSteps.includes(id)),
      )
      .map((entry) => {
        const evidenceIds = dedupeStrings(entry.step.evidenceIds)
          .filter((id) => currentEvidenceIds.has(id))
          .slice(0, 8);
        return { ...entry, evidenceIds };
      })
      .filter(
        (entry) => entry.dependency.dependsOn.length > 0 || entry.evidenceIds.length > 0,
      );
    const selectedCandidates = candidates.slice(0, this.maximumHints);
    const boundedEvidenceIds = dedupeStrings(
      selectedCandidates.flatMap((entry) => entry.evidenceIds),
    ).slice(0, this.maximumEvidenceReferences);
    const allowedEvidenceIds = new Set(boundedEvidenceIds);
    const allDependencyIds = dedupeStrings(
      selectedCandidates.flatMap((entry) => entry.dependency.dependsOn),
    );
    const boundedDependencyIds = allDependencyIds.slice(
      0,
      this.maximumDependencyReferences,
    );
    const allowedDependencyIds = new Set(boundedDependencyIds);
    const selected = selectedCandidates.map((entry) => ({
      ...entry,
      dependency: {
        ...entry.dependency,
        dependsOn: entry.dependency.dependsOn.filter((id) => allowedDependencyIds.has(id)),
      },
      evidenceIds: entry.evidenceIds.filter((id) => allowedEvidenceIds.has(id)),
    }));
    const generatedAt = now();
    const projection: PredictiveContextProjection = {
      readyStepIds: selected.map((entry) => entry.step.id),
      satisfiedDependencyIds: boundedDependencyIds,
      evidenceIds: boundedEvidenceIds,
      truncated:
        candidates.length > selected.length ||
        allDependencyIds.length > boundedDependencyIds.length ||
        dedupeStrings(selectedCandidates.flatMap((entry) => entry.evidenceIds)).length >
          boundedEvidenceIds.length,
      generatedAt,
    };
    if (selected.length === 0) return { projection };

    const content = [
      'Dependency-ready planning hints (task state only; not evidence):',
      ...selected.map(
        ({ step, dependency, evidenceIds }) =>
          `- Step ${step.id}: ${step.description}; satisfied dependencies: ${
            dependency.dependsOn.join(', ') || 'none'
          }; currently admitted evidence references: ${evidenceIds.join(', ') || 'none'}.`,
      ),
      'Use these hints only to sequence already-defined task work. They do not establish facts or satisfy evidence requirements.',
    ].join('\n');
    const source = sourceMetadata({
      id: `predictive-task:${taskState.taskId}`,
      name: 'Dependency-derived task projection',
      type: 'task-state',
      sourceKind: 'TASK_STATE',
      authority: 0.9,
      observedAt: taskState.updatedAt,
      evidenceIdentity: `predictive-task:${taskState.taskId}:${stableHash(projection)}`,
      policyLabels: ['planning-only', 'not-evidence'],
    });
    return {
      projection,
      item: {
        id: `context:prediction:${stableHash({ taskId: taskState.taskId, projection })}`,
        kind: 'task-state',
        title: 'Dependency-ready task projection',
        content,
        structured: projection,
        source,
        provenance: provenance(
          source,
          'synthesized',
          'predictive-context-intelligence',
          projection.readyStepIds,
          { planningOnly: true },
        ),
        dependencyIds: projection.satisfiedDependencyIds,
        lifecycleState: 'admitted',
        relevance: 0.8,
        confidence: 1,
        authority: 0.9,
        freshness: 1,
        priority: 'normal',
        tokenEstimate: estimateTokens(content),
        createdAt: generatedAt,
        policyLabels: ['planning-only', 'not-evidence'],
        active: true,
      },
    };
  }
}

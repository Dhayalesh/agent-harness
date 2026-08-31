import type {
  CapabilityResolution,
  ContextFeedbackRecord,
  ExecutableContextCapability,
  RuntimeOptimizationSummary,
  RuntimePerformanceProfile,
  RuntimeRetrievalOperation,
  SelectedCapability,
} from './contracts.js';
import { now } from './utils.js';

export type RuntimeCandidateRanking = {
  candidates: readonly SelectedCapability[];
  eligibleProfiles: number;
  reordered: boolean;
};

/**
 * Aggregates only completed runtime operations. Declared metadata estimates are
 * deliberately absent from this module.
 */
export class RuntimePerformanceIntelligence {
  private profiles: RuntimePerformanceProfile[];
  private readonly processedOperationIds: Set<string>;

  constructor(
    initial: readonly RuntimePerformanceProfile[] = [],
    private readonly maximumProfiles = 50,
  ) {
    this.profiles = initial.slice(-maximumProfiles).map((profile) => structuredClone(profile));
    this.processedOperationIds = new Set(
      this.profiles.flatMap((profile) => profile.processedOperationIds),
    );
  }

  ingest(
    operations: readonly RuntimeRetrievalOperation[],
    feedback: readonly ContextFeedbackRecord[],
  ): readonly RuntimePerformanceProfile[] {
    for (const operation of operations) {
      if (operation.status === 'planned') continue;
      const key = profileKey(operation.toolName, operation.capability);
      const existing = this.profiles.find(
        (profile) => profileKey(profile.toolName, profile.capability) === key,
      );
      if (this.processedOperationIds.has(operation.id)) continue;
      const operationFeedback = feedback.filter(
        (record) => record.operationId === operation.id && record.category === 'retrieval',
      );
      const profile = existing ?? emptyProfile(operation.toolName, operation.capability);
      const succeeded = operation.status === 'succeeded';
      const useful = operationFeedback.some((record) => record.outcome === 'useful');
      const irrelevant = operationFeedback.some((record) => record.outcome === 'irrelevant');
      const duplicate = operationFeedback.some((record) => record.outcome === 'duplicate');
      const failed = !succeeded;
      const classified = useful || irrelevant || duplicate || failed;
      const observedDuration = finiteNonNegative(
        operation.executionDurationMs ?? operation.durationMs,
      );
      const costs = mergeCost(profile.observedCosts, operation.observedCost);
      const updated: RuntimePerformanceProfile = {
        ...profile,
        completedSamples: profile.completedSamples + 1,
        succeededSamples: profile.succeededSamples + (succeeded ? 1 : 0),
        usefulSamples: profile.usefulSamples + (useful ? 1 : 0),
        irrelevantSamples: profile.irrelevantSamples + (irrelevant ? 1 : 0),
        failedSamples: profile.failedSamples + (failed ? 1 : 0),
        duplicateSamples: profile.duplicateSamples + (duplicate ? 1 : 0),
        classifiedSamples: profile.classifiedSamples + (classified ? 1 : 0),
        durationSamples: profile.durationSamples + (observedDuration === undefined ? 0 : 1),
        totalDurationMs:
          profile.totalDurationMs + (observedDuration === undefined ? 0 : observedDuration),
        observedCosts: costs,
        processedOperationIds: [...profile.processedOperationIds, operation.id].slice(-200),
        updatedAt: now(),
      };
      this.processedOperationIds.add(operation.id);
      if (existing) this.profiles[this.profiles.indexOf(existing)] = updated;
      else this.profiles.push(updated);
    }
    if (this.profiles.length > this.maximumProfiles) {
      this.profiles = [...this.profiles]
        .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
        .slice(-this.maximumProfiles);
    }
    return this.snapshot();
  }

  rank(
    candidates: readonly SelectedCapability[],
    capability: ExecutableContextCapability,
    minimumComparableSamples: number,
  ): RuntimeCandidateRanking {
    return rankRuntimeCandidates(
      candidates,
      capability,
      this.profiles,
      minimumComparableSamples,
    );
  }

  summary(
    enabled: boolean,
    resolutions: readonly CapabilityResolution[],
    minimumComparableSamples: number,
  ): RuntimeOptimizationSummary {
    if (!enabled) {
      return {
        enabled: false,
        eligibleProfiles: 0,
        reorderedSelections: 0,
        durationSamples: 0,
        costSamples: 0,
        unavailableReason: 'disabled',
      };
    }
    const eligibleProfileKeys = new Set<string>();
    for (const resolution of resolutions) {
      for (const capability of resolution.requiredCapabilities) {
        if (capability === 'WEB_RETRIEVAL') continue;
        const names = resolution.alternatives[capability] ?? [];
        if (names.length < 2) continue;
        const cohort = names.map((name) =>
          this.profiles.find(
            (profile) => profile.toolName === name && profile.capability === capability,
          ),
        );
        if (
          cohort.every(
            (profile) =>
              profile !== undefined &&
              profile.completedSamples >= minimumComparableSamples,
          )
        ) {
          for (const profile of cohort) {
            eligibleProfileKeys.add(profileKey(profile!.toolName, profile!.capability));
          }
        }
      }
    }
    const eligible = this.profiles.filter((profile) =>
      eligibleProfileKeys.has(profileKey(profile.toolName, profile.capability)),
    );
    const eligibleProfiles = eligible.length;
    const durationSamples = eligible.reduce(
      (total, profile) => total + profile.durationSamples,
      0,
    );
    const costSamples = eligible.reduce(
      (total, profile) =>
        total + profile.observedCosts.reduce((subtotal, cost) => subtotal + cost.samples, 0),
      0,
    );
    const reorderedSelections = resolutions.filter(
      (resolution) => resolution.selectionBasis === 'observed_performance',
    ).length;
    return {
      enabled: true,
      eligibleProfiles,
      reorderedSelections,
      durationSamples,
      costSamples,
      ...(this.profiles.length === 0
        ? { unavailableReason: 'no_runtime_operations' as const }
        : eligibleProfiles < 2
          ? { unavailableReason: 'insufficient_comparable_samples' as const }
          : costSamples === 0
            ? { unavailableReason: 'no_observed_cost' as const }
            : {}),
    };
  }

  snapshot(): readonly RuntimePerformanceProfile[] {
    return this.profiles.map((profile) => structuredClone(profile));
  }
}

export function rankRuntimeCandidates(
  candidates: readonly SelectedCapability[],
  capability: ExecutableContextCapability,
  profiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
): RuntimeCandidateRanking {
  if (candidates.length < 2) {
    return { candidates: [...candidates], eligibleProfiles: 0, reordered: false };
  }
  const entries = candidates.map((candidate, index) => ({
    candidate,
    index,
    profile: profiles.find(
      (profile) =>
        profile.toolName === candidate.capability.name && profile.capability === capability,
    ),
  }));
  const eligible = entries.filter(
    (entry) => (entry.profile?.completedSamples ?? 0) >= minimumComparableSamples,
  );
  // Preserve the existing order unless every candidate has comparable observed data.
  if (eligible.length !== entries.length) {
    return {
      candidates: [...candidates],
      eligibleProfiles: eligible.length,
      reordered: false,
    };
  }
  const cohortProfiles = entries.map((entry) => entry.profile!);
  const comparison = comparableDimensions(cohortProfiles, minimumComparableSamples);
  const ranked = [...entries].sort((left, right) => {
    const result = compareProfiles(left.profile!, right.profile!, comparison);
    return result || left.index - right.index;
  });
  const ordered = ranked.map((entry) => entry.candidate);
  return {
    candidates: ordered,
    eligibleProfiles: eligible.length,
    reordered: ordered.some((candidate, index) => candidate !== candidates[index]),
  };
}

type ComparableDimensions = {
  usefulness: boolean;
  costUnit?: string;
  latency: boolean;
};

function comparableDimensions(
  profiles: readonly RuntimePerformanceProfile[],
  minimumComparableSamples: number,
): ComparableDimensions {
  const usefulness = profiles.every(
    (profile) => profile.classifiedSamples >= minimumComparableSamples,
  );
  const commonCostUnits = profiles[0]!.observedCosts
    .filter((cost) => cost.samples >= minimumComparableSamples)
    .map((cost) => cost.unit)
    .filter((unit) =>
      profiles.every((profile) =>
        profile.observedCosts.some(
          (cost) => cost.unit === unit && cost.samples >= minimumComparableSamples,
        ),
      ),
    )
    .sort();
  return {
    usefulness,
    ...(commonCostUnits[0] === undefined ? {} : { costUnit: commonCostUnits[0] }),
    latency: profiles.every(
      (profile) => profile.durationSamples >= minimumComparableSamples,
    ),
  };
}

function compareProfiles(
  left: RuntimePerformanceProfile,
  right: RuntimePerformanceProfile,
  dimensions: ComparableDimensions,
): number {
  const failureDifference =
    rate(left.failedSamples, left.completedSamples) -
    rate(right.failedSamples, right.completedSamples);
  if (Math.abs(failureDifference) > 1e-9) return failureDifference;

  if (dimensions.usefulness) {
    const usefulnessDifference =
      rate(right.usefulSamples, right.classifiedSamples) -
      rate(left.usefulSamples, left.classifiedSamples);
    if (Math.abs(usefulnessDifference) > 1e-9) return usefulnessDifference;
  }

  if (dimensions.costUnit) {
    const leftCost = left.observedCosts.find((cost) => cost.unit === dimensions.costUnit)!;
    const rightCost = right.observedCosts.find((cost) => cost.unit === dimensions.costUnit)!;
    const costDifference =
      leftCost.total / leftCost.samples - rightCost.total / rightCost.samples;
    if (Math.abs(costDifference) > 1e-9) return costDifference;
  }

  if (dimensions.latency) {
    const latencyDifference =
      left.totalDurationMs / left.durationSamples -
      right.totalDurationMs / right.durationSamples;
    if (Math.abs(latencyDifference) > 1e-9) return latencyDifference;
  }
  return 0;
}

function emptyProfile(
  toolName: string,
  capability: ExecutableContextCapability,
): RuntimePerformanceProfile {
  return {
    toolName,
    capability,
    completedSamples: 0,
    succeededSamples: 0,
    usefulSamples: 0,
    irrelevantSamples: 0,
    failedSamples: 0,
    duplicateSamples: 0,
    classifiedSamples: 0,
    durationSamples: 0,
    totalDurationMs: 0,
    observedCosts: [],
    processedOperationIds: [],
    updatedAt: now(),
  };
}

function mergeCost(
  existing: RuntimePerformanceProfile['observedCosts'],
  cost: RuntimeRetrievalOperation['observedCost'],
): RuntimePerformanceProfile['observedCosts'] {
  if (!cost || finiteNonNegative(cost.amount) === undefined || !cost.unit.trim()) return existing;
  const normalizedUnit = cost.unit.trim().toLowerCase().slice(0, 50);
  const values = existing.map((entry) => ({ ...entry }));
  const match = values.find((entry) => entry.unit === normalizedUnit);
  if (match) {
    match.samples += 1;
    match.total += cost.amount;
  } else {
    values.push({ unit: normalizedUnit, samples: 1, total: cost.amount });
  }
  return values.slice(0, 20);
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function rate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : numerator / denominator;
}

function profileKey(toolName: string, capability: ExecutableContextCapability): string {
  return `${toolName}\u0000${capability}`;
}

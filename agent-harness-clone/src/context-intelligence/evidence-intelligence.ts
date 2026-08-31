import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextFreshnessRequirement,
  ContextNeed,
  EvidenceGroup,
  EvidenceItem,
  NormalizedIntent,
  TaskState,
  ToolObservation,
} from './contracts.js';
import {
  appendProvenance,
  clamp,
  containmentScore,
  dedupeStrings,
  estimateTokens,
  freshnessScore,
  lexicalSimilarity,
  stableHash,
} from './utils.js';

export type RejectedEvidence = {
  observationId: string;
  evidenceIdentity: string;
  reasons: readonly string[];
};

export type EvidenceAdmissionResult = {
  admitted: readonly EvidenceItem[];
  groups: readonly EvidenceGroup[];
  rejected: readonly RejectedEvidence[];
};

/** Normalizes useful retrieval observations into governed evidence. */
export class EvidenceIntelligence {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  admit(input: {
    requestId: string;
    intent: NormalizedIntent;
    needs: readonly ContextNeed[];
    observations: readonly ToolObservation[];
    taskState?: TaskState;
  }): EvidenceItem[] {
    return [...this.evaluate(input).admitted];
  }

  evaluate(input: {
    requestId: string;
    intent: NormalizedIntent;
    needs: readonly ContextNeed[];
    observations: readonly ToolObservation[];
    taskState?: TaskState;
  }): EvidenceAdmissionResult {
    const evaluated = input.observations
      .filter(
        (observation) =>
          observation.requestId === input.requestId &&
          (observation.outcome === 'success' || observation.outcome === 'partial') &&
          observation.content.trim().length > 0 &&
          observation.capability !== undefined,
      )
      .map((observation) =>
        evidenceFromObservation(
          observation,
          input.intent,
          input.needs,
          this.config,
          input.taskState,
        ),
      );
    const rejected: RejectedEvidence[] = evaluated
      .filter((item) => !item.evaluation.admitted)
      .map((item) => ({
        observationId: item.observationId ?? item.id,
        evidenceIdentity: item.evidenceIdentity,
        reasons: item.evaluation.reasons,
      }));
    const candidates = evaluated.filter((item) => item.evaluation.admitted);
    const clusters: Array<{ strongest: EvidenceItem; members: EvidenceItem[] }> = [];
    for (const candidate of candidates.sort(byEvidenceUtility)) {
      const cluster = clusters.find(({ strongest }) => equivalentEvidence(strongest, candidate, this.config));
      if (!cluster) {
        clusters.push({ strongest: candidate, members: [candidate] });
        continue;
      }
      cluster.members.push(candidate);
      if (evidenceUtility(candidate) > evidenceUtility(cluster.strongest)) {
        cluster.strongest = mergeEvidence(candidate, cluster.strongest);
      } else {
        cluster.strongest = mergeEvidence(cluster.strongest, candidate);
      }
    }

    const admitted: EvidenceItem[] = [];
    let usedTokens = 0;
    for (const cluster of clusters.sort((left, right) => byEvidenceUtility(left.strongest, right.strongest))) {
      const candidate = cluster.strongest;
      if (admitted.length >= this.config.budgets.maxRetrievalResults) {
        rejected.push({
          observationId: candidate.observationId ?? candidate.id,
          evidenceIdentity: candidate.evidenceIdentity,
          reasons: ['retrieval result count budget exhausted'],
        });
        continue;
      }
      if (usedTokens + candidate.tokenEstimate > this.config.budgets.maxRetrievalTokens) {
        rejected.push({
          observationId: candidate.observationId ?? candidate.id,
          evidenceIdentity: candidate.evidenceIdentity,
          reasons: ['retrieval token budget exhausted'],
        });
        continue;
      }
      admitted.push({ ...candidate, rank: admitted.length + 1 });
      usedTokens += candidate.tokenEstimate;
    }
    return {
      admitted,
      groups: groupEvidence(admitted, clusters),
      rejected,
    };
  }
}

function evidenceFromObservation(
  observation: ToolObservation,
  intent: NormalizedIntent,
  needs: readonly ContextNeed[],
  config: ContextIntelligenceConfig,
  taskState: TaskState | undefined,
): EvidenceItem {
  const matchingNeeds = needs.filter((need) => observation.needIds?.includes(need.id));
  const needMatch = matchingNeeds.length > 0;
  const requestContainment = containmentScore(intent.normalizedRequest, observation.content);
  const requestSimilarity = lexicalSimilarity(intent.normalizedRequest, observation.content);
  const normalizedContent = observation.content.toLowerCase();
  const meaningfulKeywords = intent.keywords.filter((keyword) => keyword.length >= 3).slice(0, 20);
  const keywordCoverage =
    meaningfulKeywords.length === 0
      ? 0
      : meaningfulKeywords.filter((keyword) => normalizedContent.includes(keyword.toLowerCase()))
          .length / meaningfulKeywords.length;
  const entityCoverage =
    intent.entities.length === 0
      ? 0
      : intent.entities.filter((entity) =>
          normalizedContent.includes(entity.value.toLowerCase()),
        ).length / intent.entities.length;
  const taskRelevance = taskState
    ? Math.max(
        ...taskState.plan
          .filter((step) => step.status === 'pending' || step.status === 'in_progress')
          .map((step) => lexicalSimilarity(step.description, observation.content)),
        0,
      )
    : 0;
  const exactStoredResource = matchingNeeds.some(
    (need) =>
      (need.type === 'FILE_INFORMATION' || need.type === 'ARTIFACT_INFORMATION') &&
      evidenceSourceMatchesNeed(need, observation.source),
  );
  const relevance = clamp(
    Math.max(
      exactStoredResource ? 0.85 : 0,
      requestContainment * 0.3 +
        requestSimilarity * 0.3 +
        keywordCoverage * 0.2 +
        entityCoverage * 0.15 +
        taskRelevance * 0.05,
    ),
  );
  const freshness = freshnessScore(
    observation.source.sourceTimestamp ??
      observation.source.observedAt ??
      observation.source.retrievedAt ??
      observation.createdAt,
    config.retrieval.freshnessHalfLifeMs,
  );
  const authority = evaluatedAuthority(observation.source, intent);
  const claims = dedupeStrings(
    observation.facts.length > 0
      ? observation.facts
      : observation.content
          .split(/(?<=[.!?])\s+|\n+/)
          .filter((line) => line.trim().length >= 4)
          .slice(0, 20),
  );
  const claimKeys = dedupeStrings([
    ...observation.identifiers,
    ...claims.flatMap(extractClaimKeys),
  ]).slice(0, 100);
  const authorityRequired = Math.max(
    0,
    ...matchingNeeds.map((need) =>
      need.authorityRequirement === 'AUTHORITATIVE'
        ? 0.8
        : need.authorityRequirement === 'TRUSTED'
          ? 0.6
          : 0,
    ),
  );
  const freshnessRequired = Math.max(
    0,
    ...matchingNeeds.map((need) => minimumFreshness(need.freshnessRequirement)),
  );
  const provenanceComplete = Boolean(
    observation.provenance.id &&
      observation.source.id &&
      observation.source.name &&
      observation.source.type &&
      (observation.source.retrievedAt || observation.source.observedAt) &&
      observation.provenance.steps.some((step) => step.operation === 'retrieved') &&
      (!['file', 'document', 'web', 'external', 'artifact'].includes(observation.source.type) ||
        observation.source.uri),
  );
  const discovery =
    observation.capability === 'WEB_SEARCH' ||
    observation.capability === 'FILE_DISCOVERY' ||
    observation.capability === 'ARTIFACT_DISCOVERY';
  const confidence =
    observation.outcome === 'partial' ? 0.62 : discovery ? 0.58 : observation.outcome === 'success' ? 0.9 : 0.5;
  const reasons = dedupeStrings([
    ...(relevance < config.retrieval.relevanceThreshold ? ['relevance below admission threshold'] : []),
    ...(authority < authorityRequired ? ['source authority below requirement'] : []),
    ...(freshness < freshnessRequired ? ['source freshness below requirement'] : []),
    ...(!provenanceComplete ? ['provenance incomplete'] : []),
    ...(looksPoisoned(observation.content) ? ['untrusted content contains instruction-like poisoning'] : []),
    ...(discovery
      ? ['discovery observations identify candidates but are not admissible source evidence']
      : []),
  ]);
  const hardRejection =
    relevance < config.retrieval.relevanceThreshold ||
    authority < authorityRequired ||
    freshness < freshnessRequired ||
    !provenanceComplete ||
    looksPoisoned(observation.content) ||
    discovery;
  const evidenceIdentity =
    observation.source.evidenceIdentity ??
    stableHash({
      source: observation.source.id,
      reference: observation.source.uri,
      claims,
      content: observation.structured ?? observation.content,
    });
  const evaluatedSource = {
    ...observation.source,
    authority,
    evidenceIdentity,
    extractionContext:
      observation.source.extractionContext ?? `tool observation ${observation.id}`,
  };
  return {
    id: `evidence:${observation.id}`,
    kind: 'evidence',
    title: `Evidence from ${observation.source.name}`,
    content: observation.content,
    ...(observation.structured === undefined ? {} : { structured: observation.structured }),
    source: evaluatedSource,
    provenance: appendProvenance(
      { ...observation.provenance, source: evaluatedSource },
      'validated',
      'evidence-intelligence',
      [observation.id],
      {
        relevance,
        authority,
        freshness,
        confidence,
        provenanceComplete,
        admitted: !hardRejection,
      },
    ),
    lifecycleState: 'evaluated',
    relevance,
    confidence,
    authority,
    freshness,
    priority: matchingNeeds.some((need) => need.priority === 'critical')
      ? 'essential'
      : needMatch
        ? 'high'
        : 'normal',
    tokenEstimate: estimateTokens(observation.content),
    createdAt: observation.createdAt,
    claimKeys,
    active: !hardRejection,
    claims,
    rank: 0,
    ...(observation.capability === undefined ? {} : { capability: observation.capability }),
    observationId: observation.id,
    evidenceIdentity,
    relationship: discovery ? 'discovery' : needMatch ? 'supports' : 'context',
    evaluation: {
      relevance,
      authority,
      freshness,
      confidence,
      provenanceComplete,
      admitted: !hardRejection,
      reasons,
    },
  };
}

function evidenceSourceMatchesNeed(
  need: ContextNeed,
  source: ToolObservation['source'],
): boolean {
  const reference = [need.inputs.reference, need.inputs.path, need.inputs.artifactId].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (!reference) return false;
  const basename = (value: string): string =>
    value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.toLowerCase() ??
    value.toLowerCase();
  const normalized = reference.toLowerCase();
  return [source.id, source.name, source.uri]
    .filter((value): value is string => typeof value === 'string')
    .some(
      (value) =>
        value.toLowerCase() === normalized || basename(value) === basename(reference),
    );
}

function evaluatedAuthority(
  source: ToolObservation['source'],
  intent: NormalizedIntent,
): number {
  if (
    (source.sourceKind !== 'WEB' && source.type !== 'web' && source.type !== 'external') ||
    !source.uri
  ) {
    return source.authority;
  }
  try {
    const url = new URL(source.uri);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (/\.(?:gov|edu)(?:\.[a-z]{2})?$/.test(host)) return Math.max(source.authority, 0.9);
    const entityMatch = intent.entities.some((entity) => {
      const normalized = entity.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      return normalized.length >= 2 && host.replace(/[^a-z0-9]/g, '').includes(normalized);
    });
    const primaryPath = /\/(?:docs?|documentation|developer|reference|releases?|newsroom|press)(?:\/|$)/i.test(
      url.pathname,
    );
    const officialRequired = intent.instructionSegments.retrievalInstructions.some((entry) =>
      /\b(?:official|authoritative|primary source|vendor documentation)\b/i.test(entry),
    ) || /\b(?:official|authoritative|primary source|vendor documentation)\b/i.test(
      intent.instructionSegments.userIntent,
    );
    if (officialRequired && entityMatch && primaryPath) return Math.max(source.authority, 0.88);
    if (officialRequired && entityMatch) return Math.max(source.authority, 0.82);
    if (entityMatch && primaryPath) return Math.max(source.authority, 0.8);
    return source.authority;
  } catch {
    return source.authority;
  }
}

export function groupEvidence(
  admitted: readonly EvidenceItem[],
  duplicateClusters?: readonly { strongest: EvidenceItem; members: readonly EvidenceItem[] }[],
): EvidenceGroup[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const item of admitted) {
    const keys = item.claimKeys?.length ? item.claimKeys : [`evidence:${item.evidenceIdentity}`];
    for (const key of keys) {
      const entries = groups.get(key) ?? [];
      entries.push(item);
      groups.set(key, entries);
    }
  }
  return [...groups.entries()].map(([claimKey, entries]) => {
    const strongest = [...entries].sort(byEvidenceUtility)[0]!;
    const duplicateMembers =
      duplicateClusters?.find((cluster) => cluster.strongest.evidenceIdentity === strongest.evidenceIdentity)
        ?.members ?? [];
    const evidenceIdentities = dedupeStrings([
      ...entries.map((entry) => entry.evidenceIdentity),
      ...duplicateMembers.map((entry) => entry.evidenceIdentity),
    ]).sort();
    return {
      id: `evidence_group:${stableHash({ claimKey, evidenceIdentities })}`,
      claimKey,
      evidenceIds: dedupeStrings([
        ...entries.map((entry) => entry.id),
        ...duplicateMembers.map((entry) => entry.id),
      ]),
      provenanceIds: dedupeStrings(
        entries.flatMap((entry) => [
          entry.provenance.id,
          ...(entry.supportingProvenanceIds ?? []),
        ]),
      ),
      strongestEvidenceId: strongest.id,
      duplicateCount: duplicateMembers.length > 0 ? duplicateMembers.length - 1 : 0,
      relationships: countRelationships(entries),
    };
  });
}

function mergeEvidence(strongest: EvidenceItem, duplicate: EvidenceItem): EvidenceItem {
  return {
    ...strongest,
    claims: dedupeStrings([...strongest.claims, ...duplicate.claims]),
    claimKeys: dedupeStrings([...(strongest.claimKeys ?? []), ...(duplicate.claimKeys ?? [])]),
    supportingProvenanceIds: dedupeStrings([
      ...(strongest.supportingProvenanceIds ?? []),
      strongest.provenance.id,
      duplicate.provenance.id,
      ...(duplicate.supportingProvenanceIds ?? []),
    ]),
    provenance: appendProvenance(
      {
        ...strongest.provenance,
        parentIds: dedupeStrings([
          ...strongest.provenance.parentIds,
          duplicate.provenance.id,
          ...duplicate.provenance.parentIds,
        ]),
      },
      'validated',
      'evidence-deduplication',
      [strongest.id, duplicate.id],
      { retained: strongest.id, duplicate: duplicate.id },
    ),
  };
}

function equivalentEvidence(
  left: EvidenceItem,
  right: EvidenceItem,
  config: ContextIntelligenceConfig,
): boolean {
  return (
    left.evidenceIdentity === right.evidenceIdentity ||
    stableHash(left.structured ?? left.content) === stableHash(right.structured ?? right.content) ||
    lexicalSimilarity(left.content, right.content) >= config.retrieval.deduplicationThreshold
  );
}

function extractClaimKeys(claim: string): string[] {
  if (!/[=:]|\b(?:is|was|were|equals?|reported|totals?|amount|status|version)\b/i.test(claim)) return [];
  const key = claim
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/[-+]?\$?\d[\d,]*(?:\.\d+)?%?/g, '<value>')
    .replace(/\b(?:is|was|were|equals?|reported as|amount is|totals?)\b[\s\S]*$/i, ' ')
    .replace(/[^a-z0-9_.:-]+/g, ' ')
    .trim();
  return key.length >= 3 ? [key.slice(0, 160)] : [];
}

function minimumFreshness(requirement: ContextFreshnessRequirement): number {
  if (requirement === 'CURRENT' || requirement === 'LATEST' || requirement === 'TODAY') return 0.8;
  if (requirement === 'RECENT' || requirement === 'THIS_WEEK') return 0.6;
  return 0;
}

function looksPoisoned(content: string): boolean {
  return /\b(ignore|disregard|override)\b.{0,40}\b(previous|system|developer|instructions?|policy)\b|\byou are now\b|\bsystem prompt\b/i.test(
    content,
  );
}

function countRelationships(
  entries: readonly EvidenceItem[],
): EvidenceGroup['relationships'] {
  const counts: Partial<Record<EvidenceItem['relationship'], number>> = {};
  for (const entry of entries) counts[entry.relationship] = (counts[entry.relationship] ?? 0) + 1;
  return counts;
}

function byEvidenceUtility(left: EvidenceItem, right: EvidenceItem): number {
  return evidenceUtility(right) - evidenceUtility(left);
}

function evidenceUtility(item: EvidenceItem): number {
  const priority = item.priority === 'essential' ? 1 : item.priority === 'high' ? 0.75 : 0.5;
  return (
    item.relevance * 0.3 +
    item.authority * 0.22 +
    item.freshness * 0.17 +
    item.confidence * 0.16 +
    priority * 0.1 +
    (item.evaluation.provenanceComplete ? 0.05 : 0)
  );
}

import type { ContextIntelligenceConfig } from './config.js';
import type { ContextNeed, EvidenceItem, NormalizedIntent, ToolObservation } from './contracts.js';
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

/** Normalizes useful retrieval observations into governed evidence. */
export class EvidenceIntelligence {
  constructor(private readonly config: ContextIntelligenceConfig) {}

  admit(input: {
    requestId: string;
    intent: NormalizedIntent;
    needs: readonly ContextNeed[];
    observations: readonly ToolObservation[];
  }): EvidenceItem[] {
    const candidates = input.observations
      .filter(
        (observation) =>
          observation.requestId === input.requestId &&
          (observation.outcome === 'success' || observation.outcome === 'partial') &&
          observation.content.trim().length > 0 &&
          (observation.capability === 'WEB_SEARCH' ||
            observation.capability === 'WEB_FETCH' ||
            observation.capability === 'FILE_READ'),
      )
      .map((observation) =>
        evidenceFromObservation(observation, input.intent, input.needs, this.config),
      )
      .filter((item) => item.relevance >= this.config.retrieval.relevanceThreshold);

    const admitted: EvidenceItem[] = [];
    let usedTokens = 0;
    for (const candidate of candidates.sort(byEvidenceUtility)) {
      if (
        admitted.some(
          (existing) =>
            stableHash(existing.structured ?? existing.content) ===
              stableHash(candidate.structured ?? candidate.content) ||
            lexicalSimilarity(existing.content, candidate.content) >=
              this.config.retrieval.deduplicationThreshold,
        )
      ) {
        continue;
      }
      if (admitted.length >= this.config.budgets.maxRetrievalResults) break;
      if (usedTokens + candidate.tokenEstimate > this.config.budgets.maxRetrievalTokens) continue;
      admitted.push({ ...candidate, rank: admitted.length + 1 });
      usedTokens += candidate.tokenEstimate;
    }
    return admitted;
  }
}

function evidenceFromObservation(
  observation: ToolObservation,
  intent: NormalizedIntent,
  needs: readonly ContextNeed[],
  config: ContextIntelligenceConfig,
): EvidenceItem {
  const needMatch = needs.some((need) => observation.needIds?.includes(need.id));
  const lexical = Math.max(
    containmentScore(intent.normalizedRequest, observation.content),
    ...intent.keywords.map((keyword) => containmentScore(keyword, observation.content)),
  );
  const relevance = clamp(Math.max(needMatch ? 0.75 : 0, lexical));
  const freshness = freshnessScore(
    observation.source.observedAt ?? observation.source.retrievedAt ?? observation.createdAt,
    config.retrieval.freshnessHalfLifeMs,
  );
  const claims = dedupeStrings(
    observation.facts.length > 0
      ? observation.facts
      : observation.content
          .split(/(?<=[.!?])\s+|\n+/)
          .filter((line) => line.trim().length >= 4)
          .slice(0, 20),
  );
  return {
    id: `evidence:${observation.id}`,
    kind: 'evidence',
    title: `Evidence from ${observation.source.name}`,
    content: observation.content,
    ...(observation.structured === undefined ? {} : { structured: observation.structured }),
    source: observation.source,
    provenance: appendProvenance(
      observation.provenance,
      'validated',
      'evidence-intelligence',
      [observation.id],
      {
        relevance,
        authority: observation.source.authority,
        freshness,
        deduplicated: true,
      },
    ),
    relevance,
    confidence: observation.outcome === 'success' ? 0.9 : 0.65,
    authority: observation.source.authority,
    freshness,
    priority: needMatch ? 'high' : 'normal',
    tokenEstimate: estimateTokens(observation.content),
    createdAt: observation.createdAt,
    claimKeys: dedupeStrings(observation.identifiers),
    active: true,
    claims,
    rank: 0,
    ...(observation.capability === undefined ? {} : { capability: observation.capability }),
    observationId: observation.id,
  };
}

function byEvidenceUtility(left: EvidenceItem, right: EvidenceItem): number {
  const score = (item: EvidenceItem): number =>
    item.relevance * 0.4 + item.authority * 0.25 + item.freshness * 0.2 + item.confidence * 0.15;
  return score(right) - score(left);
}

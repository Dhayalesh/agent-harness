import type { ContextIntelligenceConfig } from './config.js';
import type {
  ContextConflict,
  ContextScope,
  NormalizedIntent,
  QueryPlan,
  QueryVariant,
  RetrievalIteration,
  RetrievalOutcome,
  RetrievalProvider,
  RetrievalProviderMetadata,
  RetrievalRequest,
  RetrievalResult,
  RetrievalReranker,
} from './contracts.js';
import { QueryIntelligence } from './query-intelligence.js';
import {
  clamp,
  containmentScore,
  freshnessScore,
  id,
  estimateTokens,
  lexicalSimilarity,
  now,
  stableHash,
  uniqueTerms,
} from './utils.js';

export class RetrievalProviderRegistry {
  private readonly providers = new Map<string, RetrievalProvider>();

  constructor(initial: readonly RetrievalProvider[] = []) {
    for (const provider of initial) this.register(provider);
  }

  register(provider: RetrievalProvider): void {
    if (this.providers.has(provider.metadata.id)) {
      throw new Error(`Retrieval provider already registered: ${provider.metadata.id}`);
    }
    this.providers.set(provider.metadata.id, provider);
  }

  unregister(idValue: string): boolean {
    return this.providers.delete(idValue);
  }

  get(idValue: string): RetrievalProvider | undefined {
    return this.providers.get(idValue);
  }

  list(): readonly RetrievalProvider[] {
    return [...this.providers.values()];
  }
}

export type RoutedRetrievalProvider = {
  provider: RetrievalProvider;
  score: number;
  reasons: readonly string[];
};

export class RetrievalRouter {
  constructor(private readonly config: ContextIntelligenceConfig['retrieval']) {}

  route(
    query: QueryVariant,
    intent: NormalizedIntent,
    providers: readonly RetrievalProvider[],
  ): RoutedRetrievalProvider[] {
    return providers
      .filter((provider) => provider.metadata.enabled)
      .map((provider) => scoreProvider(query, intent, provider))
      .filter((entry) => entry.score >= 0.08)
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.maximumProvidersPerQuery);
  }
}

export class RetrievalIntelligence {
  private readonly router: RetrievalRouter;

  constructor(
    private readonly config: ContextIntelligenceConfig,
    private readonly registry: RetrievalProviderRegistry,
    private readonly queryIntelligence: QueryIntelligence,
    private readonly reranker?: RetrievalReranker,
  ) {
    this.router = new RetrievalRouter(config.retrieval);
  }

  async retrieve(input: {
    plan: QueryPlan;
    intent: NormalizedIntent;
    scope: ContextScope;
    signal: AbortSignal;
  }): Promise<RetrievalOutcome> {
    const started = Date.now();
    const iterations: RetrievalIteration[] = [];
    const allResults: RetrievalResult[] = [];
    const insufficiencies: string[] = [];
    let pending = executableQueries(input.plan);

    if (this.registry.list().length === 0 || pending.length === 0) {
      return {
        results: [],
        iterations,
        conflicts: [],
        sufficient: true,
        insufficiencies: [],
      };
    }

    for (
      let iteration = 1;
      iteration <= this.config.budgets.maxRetrievalIterations && pending.length > 0;
      iteration += 1
    ) {
      if (input.signal.aborted) break;
      if (Date.now() - started >= this.config.budgets.maxLoopMilliseconds) {
        insufficiencies.push('Retrieval stopped at its time budget.');
        break;
      }
      const iterationStarted = Date.now();
      const usedProviders = new Set<string>();
      const batch: RetrievalResult[] = [];
      for (const query of pending) {
        const routed = this.router.route(query, input.intent, this.registry.list());
        for (const route of routed) {
          if (batch.length + allResults.length >= this.config.budgets.maxRetrievalResults) break;
          usedProviders.add(route.provider.metadata.id);
          try {
            const results = await route.provider.retrieve(
              retrievalRequest(query, input.intent, input.scope, route.provider.metadata, input.signal),
            );
            batch.push(
              ...results.map((result) =>
                normalizeResult(result, query, route.provider.metadata, input.intent, this.config),
              ),
            );
          } catch {
            insufficiencies.push(`Provider ${route.provider.metadata.name} failed for query ${query.id}.`);
          }
        }
      }

      const ranked = await this.rankAndDedupe([...allResults, ...batch], input.intent, input.signal);
      const tokenBounded: RetrievalResult[] = [];
      let retrievedTokens = 0;
      for (const result of ranked.slice(0, this.config.budgets.maxRetrievalResults)) {
        const tokens = estimateTokens(result.content);
        if (retrievedTokens + tokens > this.config.budgets.maxRetrievalTokens) continue;
        tokenBounded.push(result);
        retrievedTokens += tokens;
      }
      allResults.splice(0, allResults.length, ...tokenBounded);
      const evaluation = evaluateSufficiency(allResults, input.plan, this.config);
      iterations.push({
        iteration,
        queryIds: pending.map((query) => query.id),
        providerIds: [...usedProviders],
        resultCount: batch.length,
        acceptedCount: allResults.length,
        sufficient: evaluation.sufficient,
        reason: evaluation.reason,
        durationMs: Date.now() - iterationStarted,
      });
      if (evaluation.sufficient) break;
      insufficiencies.push(...evaluation.insufficiencies);
      pending = await Promise.all(
        pending.map((query) =>
          this.queryIntelligence.refine(query, input.intent, evaluation.insufficiencies, input.signal),
        ),
      );
    }

    const conflicts = detectRetrievalConflicts(allResults);
    const finalEvaluation = evaluateSufficiency(allResults, input.plan, this.config);
    return {
      results: allResults,
      iterations,
      conflicts,
      sufficient: finalEvaluation.sufficient,
      insufficiencies: [...new Set([...insufficiencies, ...finalEvaluation.insufficiencies])],
    };
  }

  private async rankAndDedupe(
    results: readonly RetrievalResult[],
    intent: NormalizedIntent,
    signal: AbortSignal,
  ): Promise<RetrievalResult[]> {
    const unique: RetrievalResult[] = [];
    for (const result of results) {
      const duplicate = unique.find(
        (candidate) =>
          stableHash(candidate.structured ?? candidate.content) ===
            stableHash(result.structured ?? result.content) ||
          lexicalSimilarity(candidate.content, result.content) >=
            this.config.retrieval.deduplicationThreshold,
      );
      if (!duplicate) {
        unique.push(result);
        continue;
      }
      if (resultScore(result) > resultScore(duplicate)) {
        unique.splice(unique.indexOf(duplicate), 1, result);
      }
    }
    const ranked = unique.sort((left, right) => resultScore(right) - resultScore(left));
    if (!this.config.retrieval.rerank || !this.reranker || ranked.length < 2) return ranked;
    try {
      return [...(await this.reranker.rerank(intent, ranked, signal))];
    } catch {
      return ranked;
    }
  }
}

export class QueryAgent {
  constructor(
    private readonly queryIntelligence: QueryIntelligence,
    private readonly retrieval: RetrievalIntelligence,
  ) {}

  async run(input: {
    request: string;
    scope: ContextScope;
    signal: AbortSignal;
  }): Promise<{ intent: NormalizedIntent; plan: QueryPlan; outcome: RetrievalOutcome; synthesis: string }> {
    const intent = this.queryIntelligence.understand(input.request);
    const plan = await this.queryIntelligence.plan(input.request, input.signal);
    const outcome = await this.retrieval.retrieve({
      plan,
      intent,
      scope: input.scope,
      signal: input.signal,
    });
    return {
      intent,
      plan,
      outcome,
      synthesis: this.queryIntelligence.synthesize(plan, outcome.results),
    };
  }
}

function executableQueries(plan: QueryPlan): QueryVariant[] {
  const subqueries = plan.variants.filter((query) => query.kind === 'subquery');
  if (subqueries.length > 0) return subqueries;
  const rewrite = plan.variants.find((query) => query.kind === 'rewrite');
  const expansions = plan.variants.filter((query) => query.kind === 'expansion');
  return rewrite ? [rewrite, ...expansions] : [plan.variants[0], ...expansions].filter((entry): entry is QueryVariant => entry !== undefined);
}

function retrievalRequest(
  query: QueryVariant,
  intent: NormalizedIntent,
  scope: ContextScope,
  metadata: RetrievalProviderMetadata,
  signal: AbortSignal,
): RetrievalRequest {
  return {
    query,
    intent,
    scope,
    ...(metadata.modes[0] === undefined ? {} : { mode: metadata.modes[0] }),
    ...(metadata.collections[0] === undefined ? {} : { collection: metadata.collections[0] }),
    limit: 20,
    signal,
  };
}

function scoreProvider(
  query: QueryVariant,
  intent: NormalizedIntent,
  provider: RetrievalProvider,
): RoutedRetrievalProvider {
  const metadata = provider.metadata;
  const searchable = [
    metadata.name,
    metadata.description,
    ...metadata.collections,
    ...metadata.entityTypes,
    ...metadata.modes,
  ].join(' ');
  const lexical = Math.max(containmentScore(query.query, searchable), lexicalSimilarity(query.query, searchable));
  const entityMatches = intent.entities.filter((entity) =>
    metadata.entityTypes.some((type) => entity.type === type || type.toLowerCase().includes(entity.name.toLowerCase())),
  ).length;
  const authority = metadata.source.authority;
  const efficiency = 1 - clamp(metadata.cost * 0.5 + metadata.latency * 0.5);
  const entityCoverage =
    intent.entities.length === 0 ? 0 : Math.min(1, entityMatches / intent.entities.length);
  const semanticFit = lexical * 0.8 + entityCoverage * 0.2;
  const score = clamp(semanticFit * (0.75 + authority * 0.2 + efficiency * 0.05));
  return {
    provider,
    score,
    reasons: [
      ...(lexical > 0 ? ['metadata relevance'] : []),
      ...(entityMatches > 0 ? ['entity coverage'] : []),
      ...(authority >= 0.7 ? ['authoritative source'] : []),
      ...(efficiency >= 0.7 ? ['cost/latency fit'] : []),
    ],
  };
}

function normalizeResult(
  result: RetrievalResult,
  query: QueryVariant,
  provider: RetrievalProviderMetadata,
  intent: NormalizedIntent,
  config: ContextIntelligenceConfig,
): RetrievalResult {
  const relevance = clamp(
    result.relevance * 0.5 +
      Math.max(containmentScore(query.query, result.content), containmentScore(intent.normalizedRequest, result.content)) * 0.5,
  );
  const configuredAuthority =
    config.sourceAuthority[result.source.id] ??
    config.sourceAuthority[provider.id] ??
    config.sourceAuthority[provider.name] ??
    0;
  const authority = clamp(
    Math.max(
      result.authority,
      result.source.authority,
      provider.source.authority,
      configuredAuthority,
    ),
  );
  const freshness = clamp(
    result.freshness ||
      freshnessScore(
        result.source.observedAt ?? result.source.retrievedAt,
        config.retrieval.freshnessHalfLifeMs,
      ),
  );
  return {
    ...result,
    id: result.id || id('retrieval'),
    providerId: provider.id,
    queryId: query.id,
    relevance,
    authority,
    freshness,
    source: {
      ...result.source,
      provider: provider.name,
      authority,
      retrievedAt: result.source.retrievedAt ?? now(),
    },
  };
}

function resultScore(result: RetrievalResult): number {
  return result.relevance * 0.45 + result.authority * 0.25 + result.freshness * 0.2 + result.confidence * 0.1;
}

function evaluateSufficiency(
  results: readonly RetrievalResult[],
  plan: QueryPlan,
  config: ContextIntelligenceConfig,
): { sufficient: boolean; reason: string; insufficiencies: string[] } {
  if (results.length === 0) {
    return { sufficient: false, reason: 'No evidence returned.', insufficiencies: ['no results'] };
  }
  const accepted = results.filter((result) => result.relevance >= config.retrieval.relevanceThreshold);
  const queryIds = new Set(accepted.map((result) => result.queryId));
  const requiredQueries = executableQueries(plan);
  const coverage = requiredQueries.length === 0 ? 1 : requiredQueries.filter((query) => queryIds.has(query.id)).length / requiredQueries.length;
  const average = accepted.reduce((sum, result) => sum + resultScore(result), 0) / Math.max(1, accepted.length);
  const score = coverage * 0.55 + average * 0.45;
  const insufficiencies = [
    ...(accepted.length === 0 ? ['results below relevance threshold'] : []),
    ...(coverage < 1 ? ['missing subquery coverage'] : []),
    ...(average < config.retrieval.relevanceThreshold ? ['weak evidence quality'] : []),
  ];
  return {
    sufficient: score >= config.retrieval.sufficiencyThreshold,
    reason: `coverage=${coverage.toFixed(2)}, quality=${average.toFixed(2)}, score=${score.toFixed(2)}`,
    insufficiencies,
  };
}

export function detectRetrievalConflicts(results: readonly RetrievalResult[]): ContextConflict[] {
  const byClaim = new Map<string, RetrievalResult[]>();
  for (const result of results) {
    for (const key of result.claimKeys) {
      const group = byClaim.get(key) ?? [];
      group.push(result);
      byClaim.set(key, group);
    }
  }
  const conflicts: ContextConflict[] = [];
  for (const [claimKey, group] of byClaim) {
    if (group.length < 2) continue;
    const values = new Set(group.map((entry) => stableHash(entry.structured ?? entry.content)));
    if (values.size < 2) continue;
    const ranked = [...group].sort((left, right) => resultScore(right) - resultScore(left));
    const first = ranked[0];
    const second = ranked[1];
    if (!first || !second) continue;
    const authorityGap = first.authority - second.authority;
    const freshnessGap = first.freshness - second.freshness;
    const resolution = authorityGap >= 0.2 ? 'authority' : freshnessGap >= 0.2 ? 'freshness' : 'unresolved';
    conflicts.push({
      id: id('conflict'),
      claimKey,
      itemIds: group.map((entry) => entry.id),
      reason: values.size > 1 ? 'value' : 'scope',
      resolution,
      ...(resolution === 'unresolved' ? {} : { preferredItemId: first.id }),
      explanation:
        resolution === 'unresolved'
          ? `Sources disagree about ${claimKey}; authority and freshness do not resolve the conflict.`
          : `${first.source.name} is preferred for ${claimKey} by ${resolution}.`,
    });
  }
  return conflicts;
}

export function retrievalKeywords(results: readonly RetrievalResult[]): string[] {
  return [...new Set(results.flatMap((result) => uniqueTerms(result.content)))];
}

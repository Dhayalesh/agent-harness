import type { ContextBudgetCategory, SourceMetadata } from './contracts.js';

export type ContextIntelligenceFeatureFlags = {
  queryIntelligence: boolean;
  retrieval: boolean;
  memory: boolean;
  chunking: boolean;
  structuredShaping: boolean;
  capabilityNarrowing: boolean;
  observationProcessing: boolean;
  conflictDetection: boolean;
  compression: boolean;
  pruning: boolean;
  offloading: boolean;
  advancedReasoning: boolean;
  boundedFeedback: boolean;
  predictiveContext: boolean;
  observedPerformanceOptimization: boolean;
  evaluationMetrics: boolean;
};

export type ContextIntelligenceConfig = {
  enabled: boolean;
  features: ContextIntelligenceFeatureFlags;
  budgets: {
    maxInputTokens?: number;
    outputReservationTokens?: number;
    safetyMarginTokens: number;
    categoryShares: Readonly<Record<ContextBudgetCategory, number>>;
    maxRetrievalIterations: number;
    maxRetrievalResults: number;
    maxRetrievalTokens: number;
    maxRetrievalOperations: number;
    maxToolActions: number;
    maxLoopMilliseconds: number;
  };
  retrieval: {
    relevanceThreshold: number;
    sufficiencyThreshold: number;
    freshnessHalfLifeMs: number;
    maximumProvidersPerQuery: number;
    deduplicationThreshold: number;
    rerank: boolean;
  };
  memory: {
    recallLimit: number;
    admissionThreshold: number;
    relevanceThreshold: number;
    maximumItems: number;
    defaultTtlMs?: number;
    allowedPrivacy: readonly ('public' | 'internal' | 'confidential' | 'restricted')[];
  };
  query: {
    maximumExpansions: number;
    maximumSubqueries: number;
    minimumRewriteLength: number;
    aliases: Readonly<Record<string, readonly string[]>>;
    /**
     * Optional per-capability default maximum query lengths in characters, keyed by
     * generic capability name (e.g. `{ 'WEB_SEARCH': 400 }`).  Used by the retrieval
     * planner as a final fallback when neither the tool's JSON schema nor the
     * CapabilityMetadata declares a constraint on query length.  Configurable so that
     * deployments can declare known runtime limits without modifying capability
     * registrations.  Keys are ContextCapability strings; values must be positive
     * integers.  The default is an empty record — no fabricated constraints.
     */
    capabilityQueryLengths: Readonly<Record<string, number>>;
  };
  hygiene: {
    relevanceThreshold: number;
    authorityThreshold: number;
    freshnessThreshold: number;
    compressionThresholdTokens: number;
    offloadThresholdChars: number;
    maximumActiveItems: number;
  };
  capability: {
    relevanceThreshold: number;
    maximumExposed: number;
    minimumExposed: number;
    alwaysExpose: readonly string[];
  };
  chunking: {
    defaultStrategy:
      'fixed' | 'recursive' | 'document' | 'semantic' | 'llm' | 'agentic' | 'hierarchical' | 'late';
    targetTokens: number;
    overlapTokens: number;
    maximumTokens: number;
    semanticThreshold: number;
  };
  reasoning: {
    mode: 'auto' | 'direct' | 'react' | 'alternatives' | 'tree';
    examples: readonly { input: string; output: string }[];
    maximumAlternatives: number;
  };
  quality: {
    conflictPolicy: 'proceed' | 'clarify' | 'abstain';
    unavailablePolicy: 'abstain' | 'clarify';
  };
  p3: {
    maximumFeedbackRecords: number;
    maximumPerformanceProfiles: number;
    minimumComparableSamples: number;
    maximumPredictiveHints: number;
    maximumEvaluationOperations: number;
    maximumSourceReferencesPerFeedback: number;
  };
  sourceAuthority: Readonly<Record<string, number>>;
  sourceMetadata: readonly SourceMetadata[];
  policyLabels: readonly string[];
};

export type ContextIntelligenceConfigInput = {
  enabled?: boolean;
  features?: Partial<ContextIntelligenceFeatureFlags>;
  budgets?: Partial<Omit<ContextIntelligenceConfig['budgets'], 'categoryShares'>> & {
    categoryShares?: Partial<Readonly<Record<ContextBudgetCategory, number>>>;
  };
  retrieval?: Partial<ContextIntelligenceConfig['retrieval']>;
  memory?: Partial<ContextIntelligenceConfig['memory']>;
  query?: Partial<
    Omit<ContextIntelligenceConfig['query'], 'aliases' | 'capabilityQueryLengths'>
  > & {
    aliases?: Readonly<Record<string, readonly string[]>>;
    capabilityQueryLengths?: Readonly<Record<string, number>>;
  };
  hygiene?: Partial<ContextIntelligenceConfig['hygiene']>;
  capability?: Partial<ContextIntelligenceConfig['capability']>;
  chunking?: Partial<ContextIntelligenceConfig['chunking']>;
  reasoning?: Partial<ContextIntelligenceConfig['reasoning']>;
  quality?: Partial<ContextIntelligenceConfig['quality']>;
  p3?: Partial<ContextIntelligenceConfig['p3']>;
  sourceAuthority?: Readonly<Record<string, number>>;
  sourceMetadata?: readonly SourceMetadata[];
  policyLabels?: readonly string[];
};

const CATEGORY_SHARES: Readonly<Record<ContextBudgetCategory, number>> = {
  systemInstructions: 0.12,
  taskInstructions: 0.08,
  userRequest: 0.1,
  conversationHistory: 0.18,
  memory: 0.1,
  retrievalEvidence: 0.2,
  toolObservations: 0.1,
  toolDefinitions: 0.06,
  taskState: 0.07,
  safetyPolicy: 0.05,
};

export const DEFAULT_CONTEXT_INTELLIGENCE_CONFIG: ContextIntelligenceConfig = {
  enabled: true,
  features: {
    queryIntelligence: true,
    retrieval: true,
    memory: true,
    chunking: true,
    structuredShaping: true,
    capabilityNarrowing: true,
    observationProcessing: true,
    conflictDetection: true,
    compression: true,
    pruning: true,
    offloading: true,
    advancedReasoning: false,
    // P3 is opt-in so existing sessions retain byte-for-byte planning behavior.
    boundedFeedback: false,
    predictiveContext: false,
    observedPerformanceOptimization: false,
    evaluationMetrics: false,
  },
  budgets: {
    safetyMarginTokens: 1_024,
    categoryShares: CATEGORY_SHARES,
    maxRetrievalIterations: 3,
    maxRetrievalResults: 40,
    maxRetrievalTokens: 20_000,
    maxRetrievalOperations: 8,
    maxToolActions: 16,
    maxLoopMilliseconds: 20_000,
  },
  retrieval: {
    relevanceThreshold: 0.35,
    sufficiencyThreshold: 0.68,
    freshnessHalfLifeMs: 30 * 24 * 60 * 60 * 1_000,
    maximumProvidersPerQuery: 3,
    deduplicationThreshold: 0.9,
    rerank: true,
  },
  memory: {
    recallLimit: 12,
    admissionThreshold: 0.65,
    relevanceThreshold: 0.3,
    maximumItems: 500,
    allowedPrivacy: ['public', 'internal', 'confidential'],
  },
  query: {
    maximumExpansions: 4,
    maximumSubqueries: 8,
    minimumRewriteLength: 8,
    aliases: {},
    capabilityQueryLengths: {},
  },
  hygiene: {
    relevanceThreshold: 0.2,
    authorityThreshold: 0.2,
    freshnessThreshold: 0.1,
    compressionThresholdTokens: 2_000,
    offloadThresholdChars: 40_000,
    maximumActiveItems: 100,
  },
  capability: {
    relevanceThreshold: 0.12,
    maximumExposed: 20,
    minimumExposed: 3,
    alwaysExpose: [],
  },
  chunking: {
    defaultStrategy: 'recursive',
    targetTokens: 512,
    overlapTokens: 64,
    maximumTokens: 1_024,
    semanticThreshold: 0.42,
  },
  reasoning: {
    mode: 'auto',
    examples: [],
    maximumAlternatives: 4,
  },
  quality: {
    conflictPolicy: 'proceed',
    unavailablePolicy: 'abstain',
  },
  p3: {
    maximumFeedbackRecords: 200,
    maximumPerformanceProfiles: 50,
    minimumComparableSamples: 3,
    maximumPredictiveHints: 8,
    maximumEvaluationOperations: 200,
    maximumSourceReferencesPerFeedback: 8,
  },
  sourceAuthority: {},
  sourceMetadata: [],
  policyLabels: [],
};

export function resolveContextIntelligenceConfig(
  input: ContextIntelligenceConfigInput = {},
): ContextIntelligenceConfig {
  const categoryShares = normalizeShares({
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets.categoryShares,
    ...input.budgets?.categoryShares,
  });
  return {
    ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG,
    ...input,
    features: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.features, ...input.features },
    budgets: {
      ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.budgets,
      ...input.budgets,
      categoryShares,
    },
    retrieval: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.retrieval, ...input.retrieval },
    memory: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.memory, ...input.memory },
    query: {
      maximumExpansions:
        input.query?.maximumExpansions ??
        DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query.maximumExpansions,
      maximumSubqueries:
        input.query?.maximumSubqueries ??
        DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query.maximumSubqueries,
      minimumRewriteLength:
        input.query?.minimumRewriteLength ??
        DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query.minimumRewriteLength,
      aliases: {
        ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query.aliases,
        ...(input.query?.aliases ?? {}),
      },
      capabilityQueryLengths: {
        ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.query.capabilityQueryLengths,
        ...(input.query?.capabilityQueryLengths ?? {}),
      },
    },
    hygiene: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.hygiene, ...input.hygiene },
    capability: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.capability, ...input.capability },
    chunking: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.chunking, ...input.chunking },
    reasoning: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.reasoning, ...input.reasoning },
    quality: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.quality, ...input.quality },
    p3: { ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.p3, ...input.p3 },
    sourceAuthority: {
      ...DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.sourceAuthority,
      ...input.sourceAuthority,
    },
    sourceMetadata: [
      ...(input.sourceMetadata ?? DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.sourceMetadata),
    ],
    policyLabels: [...(input.policyLabels ?? DEFAULT_CONTEXT_INTELLIGENCE_CONFIG.policyLabels)],
  };
}

function normalizeShares(
  shares: Readonly<Record<ContextBudgetCategory, number>>,
): Readonly<Record<ContextBudgetCategory, number>> {
  const entries = Object.entries(shares) as [ContextBudgetCategory, number][];
  const total = entries.reduce((sum, [, value]) => sum + Math.max(0, value), 0) || 1;
  return Object.fromEntries(
    entries.map(([key, value]) => [key, Math.max(0, value) / total]),
  ) as Record<ContextBudgetCategory, number>;
}

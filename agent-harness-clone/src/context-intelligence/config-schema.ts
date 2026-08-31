import { z } from 'zod';

const unit = z.number().min(0).max(1);
const positiveInteger = z.number().int().positive();
const sourceType = z.enum([
  'user',
  'conversation',
  'memory',
  'file',
  'web',
  'mcp',
  'database',
  'api',
  'task-state',
  'artifact',
  'application-context',
  'document',
  'structured',
  'vector',
  'semantic',
  'keyword',
  'hybrid',
  'tool',
  'external',
  'derived',
]);
const contextSourceKind = z.enum([
  'FILE',
  'WEB',
  'MEMORY',
  'MCP',
  'DATABASE',
  'API',
  'TASK_STATE',
  'ARTIFACT',
  'APPLICATION_CONTEXT',
]);

export const contextSourceMetadataSchema = z
  .object({
    id: z.string().min(1).max(300),
    name: z.string().min(1).max(300),
    type: sourceType,
    sourceKind: contextSourceKind.optional(),
    provider: z.string().min(1).max(300).optional(),
    authority: unit,
    retrievedAt: z.iso.datetime().optional(),
    observedAt: z.iso.datetime().optional(),
    sourceTimestamp: z.iso.datetime().optional(),
    validFrom: z.iso.datetime().optional(),
    validUntil: z.iso.datetime().optional(),
    version: z.string().max(300).optional(),
    scope: z.array(z.string().max(300)).max(100).optional(),
    uri: z.string().max(4_096).optional(),
    contentHash: z.string().max(300).optional(),
    extractionContext: z.string().max(2_000).optional(),
    evidenceIdentity: z.string().max(300).optional(),
    policyLabels: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();

export const contextIntelligenceConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    features: z
      .object({
        queryIntelligence: z.boolean().optional(),
        retrieval: z.boolean().optional(),
        memory: z.boolean().optional(),
        chunking: z.boolean().optional(),
        structuredShaping: z.boolean().optional(),
        capabilityNarrowing: z.boolean().optional(),
        observationProcessing: z.boolean().optional(),
        conflictDetection: z.boolean().optional(),
        compression: z.boolean().optional(),
        pruning: z.boolean().optional(),
        offloading: z.boolean().optional(),
        advancedReasoning: z.boolean().optional(),
        boundedFeedback: z.boolean().optional(),
        predictiveContext: z.boolean().optional(),
        observedPerformanceOptimization: z.boolean().optional(),
        evaluationMetrics: z.boolean().optional(),
      })
      .strict()
      .optional(),
    budgets: z
      .object({
        maxInputTokens: positiveInteger.max(10_000_000).optional(),
        outputReservationTokens: positiveInteger.max(10_000_000).optional(),
        safetyMarginTokens: z.number().int().nonnegative().max(1_000_000).optional(),
        categoryShares: z
          .object({
            systemInstructions: unit.optional(),
            taskInstructions: unit.optional(),
            userRequest: unit.optional(),
            conversationHistory: unit.optional(),
            memory: unit.optional(),
            retrievalEvidence: unit.optional(),
            toolObservations: unit.optional(),
            toolDefinitions: unit.optional(),
            taskState: unit.optional(),
            safetyPolicy: unit.optional(),
          })
          .strict()
          .optional(),
        maxRetrievalIterations: positiveInteger.max(20).optional(),
        maxRetrievalResults: positiveInteger.max(1_000).optional(),
        maxRetrievalTokens: positiveInteger.max(10_000_000).optional(),
        maxRetrievalOperations: positiveInteger.max(1_000).optional(),
        maxToolActions: positiveInteger.max(1_000).optional(),
        maxLoopMilliseconds: positiveInteger.max(600_000).optional(),
      })
      .strict()
      .optional(),
    retrieval: z
      .object({
        relevanceThreshold: unit.optional(),
        sufficiencyThreshold: unit.optional(),
        freshnessHalfLifeMs: positiveInteger.optional(),
        maximumProvidersPerQuery: positiveInteger.max(100).optional(),
        deduplicationThreshold: unit.optional(),
        rerank: z.boolean().optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        recallLimit: positiveInteger.max(1_000).optional(),
        admissionThreshold: unit.optional(),
        relevanceThreshold: unit.optional(),
        maximumItems: positiveInteger.max(100_000).optional(),
        defaultTtlMs: positiveInteger.optional(),
        allowedPrivacy: z
          .array(z.enum(['public', 'internal', 'confidential', 'restricted']))
          .max(4)
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maximumExpansions: z.number().int().nonnegative().max(50).optional(),
        maximumSubqueries: positiveInteger.max(100).optional(),
        minimumRewriteLength: z.number().int().nonnegative().max(10_000).optional(),
        aliases: z.record(z.string(), z.array(z.string().max(300)).max(50)).optional(),
      })
      .strict()
      .optional(),
    hygiene: z
      .object({
        relevanceThreshold: unit.optional(),
        authorityThreshold: unit.optional(),
        freshnessThreshold: unit.optional(),
        compressionThresholdTokens: positiveInteger.max(10_000_000).optional(),
        offloadThresholdChars: positiveInteger.max(100_000_000).optional(),
        maximumActiveItems: positiveInteger.max(10_000).optional(),
      })
      .strict()
      .optional(),
    capability: z
      .object({
        relevanceThreshold: unit.optional(),
        maximumExposed: positiveInteger.max(1_000).optional(),
        minimumExposed: z.number().int().nonnegative().max(1_000).optional(),
        alwaysExpose: z.array(z.string().max(200)).max(1_000).optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        defaultStrategy: z
          .enum([
            'fixed',
            'recursive',
            'document',
            'semantic',
            'llm',
            'agentic',
            'hierarchical',
            'late',
          ])
          .optional(),
        targetTokens: positiveInteger.max(1_000_000).optional(),
        overlapTokens: z.number().int().nonnegative().max(1_000_000).optional(),
        maximumTokens: positiveInteger.max(1_000_000).optional(),
        semanticThreshold: unit.optional(),
      })
      .strict()
      .optional(),
    reasoning: z
      .object({
        mode: z.enum(['auto', 'direct', 'react', 'alternatives', 'tree']).optional(),
        examples: z
          .array(
            z
              .object({
                input: z.string().min(1).max(10_000),
                output: z.string().min(1).max(20_000),
              })
              .strict(),
          )
          .max(20)
          .optional(),
        maximumAlternatives: positiveInteger.max(20).optional(),
      })
      .strict()
      .optional(),
    quality: z
      .object({
        conflictPolicy: z.enum(['proceed', 'clarify', 'abstain']).optional(),
        unavailablePolicy: z.enum(['abstain', 'clarify']).optional(),
      })
      .strict()
      .optional(),
    p3: z
      .object({
        maximumFeedbackRecords: positiveInteger.max(1_000).optional(),
        maximumPerformanceProfiles: positiveInteger.max(100).optional(),
        minimumComparableSamples: positiveInteger.max(100).optional(),
        maximumPredictiveHints: positiveInteger.max(20).optional(),
        maximumEvaluationOperations: positiveInteger.max(1_000).optional(),
        maximumSourceReferencesPerFeedback: positiveInteger.max(20).optional(),
      })
      .strict()
      .optional(),
    sourceAuthority: z.record(z.string(), unit).optional(),
    sourceMetadata: z.array(contextSourceMetadataSchema).max(1_000).optional(),
    policyLabels: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();

export type ContextIntelligenceConfigWire = z.output<typeof contextIntelligenceConfigSchema>;

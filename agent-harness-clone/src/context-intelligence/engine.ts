import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { AgentMessage } from '../core/messages.js';
import type { StopReason } from '../models/provider.js';
import type { Tool, ToolExecutionResult } from '../tools/tool.js';
import {
  CapabilityIntelligence,
  inferGenericCapabilities,
  type CapabilityMetadataProvider,
} from './capability-intelligence.js';
import { ChunkingIntelligence, type ChunkingStrategy } from './chunking.js';
import {
  resolveContextIntelligenceConfig,
  type ContextIntelligenceConfig,
  type ContextIntelligenceConfigInput,
} from './config.js';
import type {
  CapabilityMetadata,
  ContextContract,
  ContextEvaluationSnapshot,
  ContextLifecycleSnapshot,
  ContextNeed,
  ContextQualityDecision,
  ContextQualityReport,
  ContextRuntimeAction,
  ContextScope,
  FinalizedContext,
  MemoryItem,
  PersistedContextIntelligenceState,
  ReasoningSupport,
  RetrievalProvider,
  RetrievalReranker,
  RuntimeOperationSnapshot,
  RuntimeRetrievalOperation,
  ToolObservation,
} from './contracts.js';
import {
  ContextFinalizer,
  ContextHygieneEngine,
  ContextOffloader,
  type SemanticSummarizer,
} from './hygiene.js';
import {
  MemoryIntelligence,
  LayeredMemoryProvider,
  SessionMemoryProvider,
  TaskStateManager,
  type MemoryCandidate,
  type MemoryProvider,
} from './memory.js';
import { ObservationIntelligence, type ProcessedObservation } from './observation-intelligence.js';
import { QueryIntelligence, type QueryTransformer } from './query-intelligence.js';
import { RetrievalIntelligence, RetrievalProviderRegistry } from './retrieval-intelligence.js';
import { MultiSourceSynthesizer } from './synthesis.js';
import { ContextNeedIntelligence } from './context-need.js';
import { EvidenceIntelligence, groupEvidence } from './evidence-intelligence.js';
import { ContextQualityGate } from './quality-gate.js';
import { RuntimeRetrievalPlanner } from './runtime-retrieval.js';
import { AdaptiveRetrievalIntelligence, annotateRuntimeOperations } from './adaptive-retrieval.js';
import { CrossDocumentIntelligence } from './cross-document.js';
import { ContextLifecycleManager } from './lifecycle.js';
import { ContextFeedbackIntelligence } from './feedback.js';
import { PredictiveContextIntelligence } from './predictive-context.js';
import { RuntimePerformanceIntelligence } from './runtime-performance.js';
import { ContextEvaluationIntelligence } from './evaluation.js';
import { ResourceIntelligence, observeResourceOperation } from './resource-intelligence.js';
import {
  deepClone,
  dedupeStrings,
  estimateTokens,
  id,
  lexicalSimilarity,
  now,
  provenance,
  sourceMetadata,
  appendProvenance,
  stableHash,
} from './utils.js';

export type ContextIntelligenceTelemetryEvent = {
  event:
    | 'context-intelligence.lifecycle'
    | 'context-intelligence.query'
    | 'context-intelligence.retrieval'
    | 'context-intelligence.memory-recall'
    | 'context-intelligence.memory-admission'
    | 'context-intelligence.capability-selection'
    | 'context-intelligence.observation'
    | 'context-intelligence.evidence'
    | 'context-intelligence.hygiene'
    | 'context-intelligence.feedback'
    | 'context-intelligence.prediction'
    | 'context-intelligence.optimization'
    | 'context-intelligence.evaluation'
    | 'context-intelligence.finalized';
  sessionId: string;
  turnId?: string;
  data: Readonly<Record<string, unknown>>;
};

export type ContextIntelligenceEngineOptions = {
  config?: ContextIntelligenceConfigInput;
  retrievalProviders?: readonly RetrievalProvider[];
  retrievalReranker?: RetrievalReranker;
  queryTransformer?: QueryTransformer;
  capabilityMetadata?: readonly CapabilityMetadata[];
  capabilityMetadataProviders?: readonly CapabilityMetadataProvider[];
  chunkingStrategies?: readonly ChunkingStrategy[];
  semanticSummarizer?: SemanticSummarizer;
  artifactStore?: ArtifactStore;
  initialState?: PersistedContextIntelligenceState;
  /** Optional governed cross-session provider for semantic/procedural/episodic memory. */
  memoryProvider?: MemoryProvider;
  onTelemetry?: (event: ContextIntelligenceTelemetryEvent) => void;
};

export type PrepareContextIntelligenceInput = {
  request: string;
  messages: readonly AgentMessage[];
  tools: readonly Tool[];
  systemPrompt: string;
  scope: ContextScope;
  sessionId: string;
  turnId: string;
  inputLimit: number;
  outputReservation: number;
  signal: AbortSignal;
};

export type PrepareContextIntelligenceResult = {
  contract: ContextContract;
  finalized: FinalizedContext;
};

export class ContextIntelligenceEngine {
  readonly config: ContextIntelligenceConfig;
  readonly chunking: ChunkingIntelligence;
  private readonly memoryProvider: SessionMemoryProvider;
  private readonly memory: MemoryIntelligence;
  private readonly query: QueryIntelligence;
  private readonly retrievalRegistry: RetrievalProviderRegistry;
  private readonly retrieval: RetrievalIntelligence;
  private readonly capabilities: CapabilityIntelligence;
  private readonly observations: ObservationIntelligence;
  private readonly hygiene: ContextHygieneEngine;
  private readonly offloader: ContextOffloader;
  private readonly finalizer: ContextFinalizer;
  private readonly synthesizer = new MultiSourceSynthesizer();
  private readonly crossDocuments = new CrossDocumentIntelligence();
  private readonly needs = new ContextNeedIntelligence();
  private readonly evidence: EvidenceIntelligence;
  private readonly qualityGate: ContextQualityGate;
  private readonly runtimeRetrieval: RuntimeRetrievalPlanner;
  private readonly adaptiveRetrieval: AdaptiveRetrievalIntelligence;
  private readonly tasks = new TaskStateManager();
  private readonly lifecycle: ContextLifecycleManager;
  private readonly feedback: ContextFeedbackIntelligence;
  private readonly predictive: PredictiveContextIntelligence;
  private readonly performance: RuntimePerformanceIntelligence;
  private readonly evaluation: ContextEvaluationIntelligence;
  private readonly resources = new ResourceIntelligence();
  private readonly onTelemetry: ((event: ContextIntelligenceTelemetryEvent) => void) | undefined;
  private taskState: ContextContract['taskState'] | undefined;
  private observationState: ToolObservation[];
  private offloadedState: ContextContract['offloadedArtifacts'][number][];
  private lastContract: ContextContract | undefined;
  private lastEvaluation: ContextEvaluationSnapshot | undefined;
  private toolActionCount = 0;
  private activeRequestId = id('request');
  private requestStartedAt = Date.now();
  private runtimeOperations: RuntimeRetrievalOperation[] = [];
  private recentOperations: RuntimeOperationSnapshot[];
  private readonly plannedActions = new Map<string, ContextRuntimeAction>();

  constructor(options: ContextIntelligenceEngineOptions = {}) {
    this.taskState = options.initialState?.taskState;
    this.observationState = [...(options.initialState?.observations ?? [])];
    this.offloadedState = [...(options.initialState?.offloadedArtifacts ?? [])];
    this.recentOperations = [...(options.initialState?.recentOperations ?? [])];
    this.lifecycle = new ContextLifecycleManager(
      restoreLifecycleEvents(options.initialState?.lifecycleEvents ?? []),
    );
    // Full legacy contracts are intentionally not restored; canonical messages and
    // bounded task/memory state remain authoritative across resume.
    this.lastContract = undefined;
    this.lastEvaluation = options.initialState?.lastEvaluation;
    this.config = resolveContextIntelligenceConfig(options.config);
    this.feedback = new ContextFeedbackIntelligence(
      options.initialState?.feedback ?? [],
      this.config.p3.maximumFeedbackRecords,
      this.config.p3.maximumSourceReferencesPerFeedback,
    );
    this.predictive = new PredictiveContextIntelligence(this.config.p3.maximumPredictiveHints);
    this.performance = new RuntimePerformanceIntelligence(
      options.initialState?.performanceProfiles ?? [],
      this.config.p3.maximumPerformanceProfiles,
    );
    this.evaluation = new ContextEvaluationIntelligence(this.config.p3.maximumEvaluationOperations);
    this.memoryProvider = new SessionMemoryProvider(options.initialState?.memories ?? []);
    this.memory = new MemoryIntelligence(
      this.config.memory,
      options.memoryProvider
        ? new LayeredMemoryProvider(this.memoryProvider, options.memoryProvider)
        : this.memoryProvider,
    );
    this.query = new QueryIntelligence(this.config.query, options.queryTransformer);
    this.retrievalRegistry = new RetrievalProviderRegistry(options.retrievalProviders ?? []);
    this.retrieval = new RetrievalIntelligence(
      this.config,
      this.retrievalRegistry,
      this.query,
      options.retrievalReranker,
    );
    this.capabilities = new CapabilityIntelligence(
      this.config.capability,
      options.capabilityMetadata,
      options.capabilityMetadataProviders,
      this.config.features.observedPerformanceOptimization,
      this.config.p3.minimumComparableSamples,
    );
    this.observations = new ObservationIntelligence(this.config, options.artifactStore);
    this.hygiene = new ContextHygieneEngine(this.config, options.semanticSummarizer);
    this.offloader = new ContextOffloader(options.artifactStore);
    this.finalizer = new ContextFinalizer(this.config);
    this.evidence = new EvidenceIntelligence(this.config);
    this.qualityGate = new ContextQualityGate(this.config);
    this.runtimeRetrieval = new RuntimeRetrievalPlanner(this.config);
    this.adaptiveRetrieval = new AdaptiveRetrievalIntelligence(this.config);
    this.chunking = new ChunkingIntelligence(this.config.chunking, options.chunkingStrategies);
    this.onTelemetry = options.onTelemetry;
  }

  async prepare(input: PrepareContextIntelligenceInput): Promise<PrepareContextIntelligenceResult> {
    const started = Date.now();
    const intent = this.query.understand(input.request);
    const initialNeeds = this.needs.identify(intent, input.scope, this.activeRequestId);
    this.lifecycle.transition({
      requestId: this.activeRequestId,
      to: 'discovered',
      reason: 'Intent and context needs were identified.',
      component: 'context-intelligence-engine',
      metadata: { needCount: initialNeeds.length, operation: intent.operation },
    });
    for (const need of initialNeeds) {
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        needId: need.id,
        to: 'discovered',
        reason: need.reason,
        component: 'context-need-intelligence',
        metadata: { type: need.type, capability: need.requiredCapability },
      });
    }
    let taskState = this.tasks.recover(this.taskState, intent, input.scope.taskId);
    this.taskState = taskState;
    const recalledMemories = this.config.features.memory
      ? await this.memory.recall(intent, input.scope, input.signal)
      : [];
    this.emit('context-intelligence.memory-recall', input, {
      recalled: recalledMemories.length,
      types: [...new Set(recalledMemories.map((memory) => memory.type))],
      layers: [...new Set(recalledMemories.map((memory) => memory.layer ?? 'unclassified'))],
    });

    const queryResult = await this.prepareQuery(
      input.request,
      input.scope,
      input.signal,
      initialNeeds,
    );
    this.emit('context-intelligence.query', input, {
      complexity: queryResult.intent.complexity,
      variants: queryResult.plan.variants.length,
      transformations: queryResult.plan.variants.map((query) => query.kind),
    });
    this.emit('context-intelligence.retrieval', input, {
      providers: [...new Set(queryResult.outcome.results.map((result) => result.providerId))],
      iterations: queryResult.outcome.iterations.length,
      results: queryResult.outcome.results.length,
      sufficient: queryResult.outcome.sufficient,
      conflicts: queryResult.outcome.conflicts.length,
    });
    for (const result of queryResult.outcome.results) {
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId: result.id,
        from: 'discovered',
        to: 'retrieved',
        reason: 'A passive context provider returned a candidate.',
        component: 'retrieval-intelligence',
        metadata: { providerId: result.providerId, queryId: result.queryId },
      });
    }

    const failedToolNames = this.runtimeOperations
      .filter(
        (operation) =>
          operation.requestId === this.activeRequestId &&
          operation.status === 'failed' &&
          operation.failureClassification !== 'not_found' &&
          operation.failureClassification !== 'invalid_input' &&
          operation.failureClassification !== 'timeout' &&
          operation.failureClassification !== 'network' &&
          operation.failureClassification !== 'rate_limited',
      )
      .map((operation) => operation.toolName);
    const toolPlan = this.config.features.capabilityNarrowing
      ? await this.capabilities.select(intent, input.tools, initialNeeds, {
          excludeToolNames: failedToolNames,
          ...(this.config.features.observedPerformanceOptimization
            ? { performanceProfiles: this.performance.snapshot() }
            : {}),
        })
      : await this.allCapabilities(intent, input.tools, initialNeeds, failedToolNames);
    this.emit('context-intelligence.capability-selection', input, {
      available: input.tools.length,
      selected: toolPlan.selected.length,
      names: toolPlan.selected.map((entry) => entry.capability.name),
    });
    const observationAdmission = this.evidence.evaluate({
      requestId: this.activeRequestId,
      intent,
      needs: initialNeeds,
      observations: this.observationState,
      taskState,
    });
    const observationEvidence = observationAdmission.admitted;
    for (const item of observationEvidence) {
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId: item.id,
        from: 'observed',
        to: 'evaluated',
        reason: 'Observation passed evidence quality evaluation.',
        component: 'evidence-intelligence',
        metadata: { evidenceIdentity: item.evidenceIdentity },
      });
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId: item.id,
        from: 'evaluated',
        to: 'admitted',
        reason: 'Evaluated evidence was admitted to canonical context.',
        component: 'evidence-intelligence',
        metadata: { rank: item.rank, relationship: item.relationship },
      });
    }
    this.emit('context-intelligence.evidence', input, {
      evaluated: observationAdmission.admitted.length + observationAdmission.rejected.length,
      admitted: observationAdmission.admitted.length,
      rejected: observationAdmission.rejected.length,
      groups: observationAdmission.groups.length,
      provenanceComplete: observationAdmission.admitted.filter(
        (item) => item.evaluation.provenanceComplete,
      ).length,
    });
    const memoryAssessment = this.memory.reconcile(
      recalledMemories,
      [...queryResult.outcome.results, ...observationEvidence],
      initialNeeds,
    );
    const memories = memoryAssessment.retained;
    this.emit('context-intelligence.memory-recall', input, {
      phase: 'reconciliation',
      retained: memories.length,
      ignored: memoryAssessment.ignoredIds.length,
      stale: memoryAssessment.staleIds.length,
      conflicts: memoryAssessment.conflictingIds.length,
    });
    for (const memory of memories) {
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId: memory.id,
        to: 'recalled',
        reason: 'Relevant memory survived freshness and evidence reconciliation.',
        component: 'memory-intelligence',
        metadata: { type: memory.type, layer: memory.layer ?? 'unclassified' },
      });
    }
    taskState = this.tasks.recordEvidence(taskState, [
      ...queryResult.outcome.results.map((result) => result.id),
      ...observationEvidence.map((item) => item.id),
    ]);
    this.taskState = taskState;
    const synthesis = this.synthesizer.synthesize({
      request: input.request,
      intent,
      scope: input.scope,
      messages: input.messages,
      memories,
      retrieval: queryResult.outcome,
      observationEvidence,
      observations: this.observationState,
      taskState,
      queryPlan: queryResult.plan,
      toolPlan,
      examples: this.config.reasoning.examples,
    });
    const crossDocumentResult = this.crossDocuments.synthesize({
      requestId: this.activeRequestId,
      items: synthesis.items,
      evidence: synthesis.evidence,
      conflicts: queryResult.outcome.conflicts,
    });
    const synthesisItems = [
      ...synthesis.items,
      ...(crossDocumentResult.item === undefined ? [] : [crossDocumentResult.item]),
    ];
    const offloadedArtifacts = [...this.offloadedState];
    const preHygiene = [];
    for (const item of synthesisItems) {
      if (
        this.config.features.offloading &&
        item.content.length > this.config.hygiene.offloadThresholdChars &&
        item.priority !== 'essential'
      ) {
        const offloaded = await this.offloader.offload(
          item,
          item.kind === 'history'
            ? 'history'
            : item.kind === 'evidence'
              ? 'document'
              : 'intermediate',
          input.sessionId,
        );
        preHygiene.push(offloaded.item);
        if (offloaded.artifact) {
          offloadedArtifacts.push(offloaded.artifact);
          this.lifecycle.transition({
            requestId: this.activeRequestId,
            itemId: item.id,
            ...(item.lifecycleState === undefined ? {} : { from: item.lifecycleState }),
            to: 'offloaded',
            reason: 'Low-priority context exceeded the active-context offload threshold.',
            component: 'context-offloader',
            metadata: { artifactId: offloaded.artifact.artifactId, kind: offloaded.artifact.kind },
          });
        }
      } else preHygiene.push(item);
    }
    this.offloadedState = offloadedArtifacts.slice(-100);
    const hygiene = await this.hygiene.process(preHygiene, input.signal, input.scope, initialNeeds);
    for (const item of hygiene.items) {
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId: item.id,
        ...(item.lifecycleState === undefined ? {} : { from: item.lifecycleState }),
        to: 'ranked',
        reason: 'Context survived hygiene and relevance ranking.',
        component: 'context-hygiene',
        metadata: { kind: item.kind, priority: item.priority },
      });
      if (hygiene.compressedItemIds.includes(item.id)) {
        this.lifecycle.transition({
          requestId: this.activeRequestId,
          itemId: item.id,
          from: 'ranked',
          to: 'compressed',
          reason: 'Context was compressed while preserving evidence metadata.',
          component: 'context-compressor',
          metadata: {},
        });
      }
    }
    const retainedIds = new Set(hygiene.items.map((item) => item.id));
    const admittedEvidence = synthesis.evidence.filter((item) => retainedIds.has(item.id));
    const adaptiveEvidence = [
      ...new Map(
        [...observationAdmission.evaluated, ...admittedEvidence].map((item) => [item.id, item]),
      ).values(),
    ];
    const evidenceGroups = groupEvidence(admittedEvidence);
    const predictiveResult = this.config.features.predictiveContext
      ? this.predictive.project(
          taskState,
          new Set(
            admittedEvidence.flatMap((item) => [
              item.id,
              ...(item.retrievalResultId ? [item.retrievalResultId] : []),
              ...(item.observationId ? [item.observationId] : []),
            ]),
          ),
        )
      : undefined;
    if (predictiveResult) {
      this.emit('context-intelligence.prediction', input, {
        hints: predictiveResult.projection.readyStepIds.length,
        dependencies: predictiveResult.projection.satisfiedDependencyIds.length,
        evidenceReferences: predictiveResult.projection.evidenceIds.length,
        truncated: predictiveResult.projection.truncated,
      });
      if (predictiveResult.item) {
        this.lifecycle.transition({
          requestId: this.activeRequestId,
          itemId: predictiveResult.item.id,
          to: 'admitted',
          reason:
            'A dependency-ready planning hint was derived from final admitted evidence and canonical task state.',
          component: 'predictive-context-intelligence',
          metadata: { planningOnly: true },
        });
        this.lifecycle.transition({
          requestId: this.activeRequestId,
          itemId: predictiveResult.item.id,
          from: 'admitted',
          to: 'ranked',
          reason: 'The bounded planning hint is eligible for final context budgeting.',
          component: 'predictive-context-intelligence',
          metadata: { planningOnly: true },
        });
      }
    }
    const governedItems = [
      ...hygiene.items,
      ...(predictiveResult?.item === undefined ? [] : [predictiveResult.item]),
    ];
    const availableSourceKinds = dedupeStrings([
      'TASK_STATE',
      ...(memories.length > 0 ? ['MEMORY'] : []),
    ]) as ContextContract['contextNeeds'][number]['sourceKinds'];
    const assessedResources = this.resources.assess({
      requestId: this.activeRequestId,
      needs: initialNeeds,
      messages: input.messages,
      offloadedArtifacts: this.offloadedState,
      operations: this.runtimeOperations,
    });
    const contextNeeds = this.needs.assess(
      initialNeeds,
      admittedEvidence,
      toolPlan.resolutions,
      availableSourceKinds,
      assessedResources,
    );
    const evidenceNeeds = contextNeeds.filter(
      (need) => need.required && need.evidenceRequirement === 'REQUIRED',
    );
    const evidenceSufficient = evidenceNeeds.every((need) => need.status === 'satisfied');
    const combinedConflicts = [...queryResult.outcome.conflicts, ...hygiene.conflicts];
    const unresolvedEvidenceConflict = combinedConflicts.some(
      (conflict) => conflict.resolution === 'unresolved',
    );
    const effectiveRetrieval = {
      ...queryResult.outcome,
      sufficient: evidenceSufficient && !unresolvedEvidenceConflict,
      insufficiencies:
        evidenceSufficient && !unresolvedEvidenceConflict
          ? []
          : dedupeStrings([
              ...queryResult.outcome.insufficiencies,
              ...(unresolvedEvidenceConflict ? ['unresolved source conflict'] : []),
              ...evidenceNeeds
                .filter((need) => need.status !== 'satisfied')
                .flatMap((need) => need.missingInformation),
            ]),
    };
    const adaptivePlanning = this.adaptiveRetrieval.evaluate({
      requestId: this.activeRequestId,
      needs: contextNeeds,
      operations: this.runtimeOperations,
      observations: this.observationState,
      evaluatedEvidence: adaptiveEvidence,
      conflicts: combinedConflicts,
      elapsedMs: Date.now() - this.requestStartedAt,
    });
    const runtimeActions = this.runtimeRetrieval.plan({
      requestId: this.activeRequestId,
      intent,
      queryPlan: queryResult.plan,
      needs: contextNeeds,
      toolPlan,
      observations: this.observationState,
      operations: this.runtimeOperations,
      resources: assessedResources,
      ...(this.config.features.observedPerformanceOptimization
        ? { performanceProfiles: this.performance.snapshot() }
        : {}),
      adaptive: adaptivePlanning,
      elapsedMs: Date.now() - this.requestStartedAt,
    });
    this.registerRuntimeActions(runtimeActions);
    const adaptiveRetrieval = this.adaptiveRetrieval.evaluate({
      requestId: this.activeRequestId,
      needs: contextNeeds,
      operations: this.runtimeOperations,
      observations: this.observationState,
      evaluatedEvidence: adaptiveEvidence,
      conflicts: combinedConflicts,
      elapsedMs: Date.now() - this.requestStartedAt,
      planningComplete: true,
    });
    annotateRuntimeOperations(this.runtimeOperations, adaptiveRetrieval);
    const latestAttempt = adaptiveRetrieval.attempts.at(-1);
    this.emit('context-intelligence.retrieval', input, {
      phase: 'adaptive',
      retrieval_attempt_count: adaptiveRetrieval.attemptCount,
      retrieval_strategy: latestAttempt?.strategy,
      retrieval_result: latestAttempt?.outcome,
      retrieval_failure_reason:
        latestAttempt?.outcome === 'RETRIEVAL_SUCCESS' ? undefined : latestAttempt?.outcome,
      adaptation_reason: latestAttempt?.adaptationReason,
      previous_strategy: latestAttempt?.previousStrategy,
      next_strategy: latestAttempt?.nextStrategy,
      retrieval_budget_remaining: adaptiveRetrieval.remainingRetrievalBudget,
      evidence_quality: adaptiveRetrieval.evidenceQuality,
      termination_reason: adaptiveRetrieval.terminationReason,
    });
    taskState = this.taskState ?? taskState;
    const resourceRecords = this.resources.assess({
      requestId: this.activeRequestId,
      needs: initialNeeds,
      messages: input.messages,
      offloadedArtifacts: this.offloadedState,
      operations: this.runtimeOperations,
    });
    const qualityGate = this.qualityGate.evaluate({
      report: { ...hygiene.report, conflicts: combinedConflicts },
      needs: contextNeeds,
      actions: runtimeActions,
      operations: this.runtimeOperations,
      adaptive: adaptiveRetrieval,
      elapsedMs: Date.now() - this.requestStartedAt,
    });
    this.emit('context-intelligence.hygiene', input, {
      candidates: preHygiene.length,
      retained: hygiene.items.length,
      pruned: hygiene.prunedItemIds.length,
      compressed: hygiene.compressedItemIds.length,
      conflicts: hygiene.conflicts.length,
      quality: qualityGate.report.status,
      decision: qualityGate.report.decision,
      score: qualityGate.report.score,
    });
    const selectedTools = toolPlan.selected
      .map((entry) => entry.descriptor)
      .filter(
        (descriptor): descriptor is NonNullable<typeof descriptor> => descriptor !== undefined,
      );
    const finalized = this.finalizer.finalize({
      items: governedItems,
      messages: input.messages,
      tools: selectedTools,
      quality: qualityGate.report,
      offloadedArtifacts: this.offloadedState,
      inputLimit: input.inputLimit,
      outputReservation: input.outputReservation,
      systemPrompt: input.systemPrompt,
    });
    const finalQualityGate = this.qualityGate.evaluate({
      report: finalized.quality,
      needs: contextNeeds,
      actions: runtimeActions,
      operations: this.runtimeOperations,
      adaptive: adaptiveRetrieval,
      elapsedMs: Date.now() - this.requestStartedAt,
    });
    const activeFinalized: FinalizedContext = {
      ...finalized,
      quality: finalQualityGate.report,
    };
    for (const itemId of activeFinalized.activeItemIds) {
      const item = governedItems.find((candidate) => candidate.id === itemId);
      this.lifecycle.transition({
        requestId: this.activeRequestId,
        itemId,
        from: hygiene.compressedItemIds.includes(itemId) ? 'compressed' : 'ranked',
        to: 'used',
        reason: 'Context item was selected for the active model context.',
        component: 'context-finalizer',
        metadata: { kind: item?.kind ?? 'unknown' },
      });
    }
    const requestLifecycle = this.lifecycle.forRequest(this.activeRequestId);
    const p3SignalsEnabled =
      this.config.features.boundedFeedback ||
      this.config.features.observedPerformanceOptimization ||
      this.config.features.evaluationMetrics;
    const feedbackRecords = p3SignalsEnabled
      ? this.feedback.collect({
          requestId: this.activeRequestId,
          operations: this.runtimeOperations,
          evidence: synthesis.evidence,
          evidenceGroups: observationAdmission.groups,
          rejectedEvidence: observationAdmission.rejected,
          memoryAssessment,
          qualityIssues: finalQualityGate.report.issues,
          finalized: activeFinalized,
          directive: finalQualityGate.directive,
          lifecycle: requestLifecycle,
        })
      : [];
    if (p3SignalsEnabled) {
      this.emit('context-intelligence.feedback', input, {
        records: feedbackRecords.length,
        categories: [...new Set(feedbackRecords.map((record) => record.category))],
        outcomes: [...new Set(feedbackRecords.map((record) => record.outcome))],
      });
    }
    if (this.config.features.observedPerformanceOptimization) {
      this.performance.ingest(this.runtimeOperations, feedbackRecords);
    }
    const optimization = this.config.features.observedPerformanceOptimization
      ? this.performance.summary(
          true,
          toolPlan.resolutions,
          this.config.p3.minimumComparableSamples,
        )
      : undefined;
    if (optimization) {
      this.emit('context-intelligence.optimization', input, {
        eligibleProfiles: optimization.eligibleProfiles,
        reorderedSelections: optimization.reorderedSelections,
        durationSamples: optimization.durationSamples,
        costSamples: optimization.costSamples,
        unavailableReason: optimization.unavailableReason,
      });
    }
    const evaluation = this.config.features.evaluationMetrics
      ? this.evaluation.evaluate({
          requestId: this.activeRequestId,
          operations: this.runtimeOperations,
          feedback: feedbackRecords,
          evidence: admittedEvidence,
          finalized: activeFinalized,
          memoryAssessment,
          directive: finalQualityGate.directive,
        })
      : undefined;
    if (evaluation) {
      this.lastEvaluation = evaluation;
      this.emit('context-intelligence.evaluation', input, {
        operationSamples: evaluation.operationSuccess?.denominator ?? 0,
        usefulnessSamples: evaluation.classifiedRetrievalUsefulness?.denominator ?? 0,
        latencySamples: evaluation.latency.samples,
        costSamples: evaluation.costs.reduce((sum, cost) => sum + cost.samples, 0),
        unavailable: evaluation.unavailable.map((entry) => entry.metric),
      });
    }
    const timestamp = now();
    const reasoning = reasoningSupport(
      intent,
      taskState,
      toolPlan.selected.length,
      queryResult.plan,
      this.config,
    );
    const contract: ContextContract = {
      version: 1,
      requestId: this.activeRequestId,
      scope: deepClone(input.scope),
      rawRequest: input.request,
      intent,
      contextNeeds,
      constraints: intent.constraints,
      requiredEntities: intent.entities.filter((entity) => entity.required),
      ...(intent.temporal === undefined ? {} : { temporal: intent.temporal }),
      memories,
      memoryAssessment,
      evidence: admittedEvidence,
      evidenceGroups,
      crossDocument: crossDocumentResult.record,
      lifecycle: requestLifecycle,
      ...(this.config.features.boundedFeedback ? { feedback: feedbackRecords } : {}),
      ...(predictiveResult === undefined ? {} : { predictiveContext: predictiveResult.projection }),
      ...(optimization === undefined ? {} : { optimization }),
      ...(evaluation === undefined ? {} : { evaluation }),
      sources: dedupeSources(governedItems.map((item) => item.source)),
      conflicts: combinedConflicts,
      capabilities: toolPlan.selected,
      toolPlan,
      observations: deepClone(this.observationState),
      findings: governedItems.filter((item) => item.kind === 'finding'),
      taskState,
      queryPlan: queryResult.plan,
      retrieval: effectiveRetrieval,
      runtimeRetrieval: deepClone(this.runtimeOperations),
      adaptiveRetrieval: deepClone(adaptiveRetrieval),
      resources: deepClone(resourceRecords),
      reasoning,
      budget: activeFinalized.budget,
      provenance: dedupeProvenance([
        ...preHygiene.map((item) => item.provenance),
        ...governedItems.map((item) => item.provenance),
      ]),
      items: governedItems,
      offloadedArtifacts: deepClone(this.offloadedState),
      finalContext: activeFinalized,
      quality: finalQualityGate.report,
      directive: finalQualityGate.directive,
      pendingDecisions: dedupeStrings([
        ...taskState.pendingDecisions,
        ...intent.ambiguity,
        ...hygiene.conflicts
          .filter((conflict) => conflict.resolution === 'unresolved')
          .map((conflict) => conflict.explanation),
      ]),
      createdAt:
        this.lastContract?.scope.taskId === input.scope.taskId
          ? this.lastContract.createdAt
          : timestamp,
      updatedAt: timestamp,
    };
    this.lastContract = contract;
    this.emit('context-intelligence.finalized', input, {
      sections: activeFinalized.sections.length,
      tools: activeFinalized.tools.length,
      inputTokens: activeFinalized.budget.usedInput,
      omittedItems: activeFinalized.omittedItemIds.length,
      quality: activeFinalized.quality.status,
      durationMs: Date.now() - started,
    });
    return { contract, finalized: activeFinalized };
  }

  beginRequest(): void {
    this.recentOperations = [
      ...this.recentOperations,
      ...this.runtimeOperations.map(runtimeOperationSnapshot),
    ].slice(-200);
    this.toolActionCount = 0;
    this.activeRequestId = id('request');
    this.requestStartedAt = Date.now();
    this.runtimeOperations = [];
    this.plannedActions.clear();
  }

  /**
   * Fail closed only when a preparation failure would otherwise let the model act
   * without evidence that the request declares mandatory. Ordinary requests retain
   * the existing degraded/fail-open compatibility behavior.
   */
  preparationFailureDecision(
    request: string,
    scope: ContextScope,
  ): Extract<ContextQualityDecision, 'ABSTAIN' | 'CLARIFY'> | undefined {
    const intent = this.query.understand(request);
    const evidenceRequired = this.needs
      .identify(intent, scope, `${this.activeRequestId}:preparation-failure`)
      .some((need) => need.required && need.evidenceRequirement === 'REQUIRED');
    if (!evidenceRequired) return undefined;
    return this.config.quality.unavailablePolicy === 'clarify' ? 'CLARIFY' : 'ABSTAIN';
  }

  async processObservation(input: {
    tool: Tool;
    toolCallId: string;
    output: ToolExecutionResult;
    sessionId: string;
    turnId: string;
    executionDurationMs?: number;
    /** Exact schema-parsed value passed to tool.execute; omitted if execution never began. */
    actualToolInput?: unknown;
  }): Promise<ProcessedObservation> {
    const { executionDurationMs, actualToolInput, ...observationInput } = input;
    const processed = await this.observations.process({
      ...observationInput,
      intent: this.lastContract?.intent ?? this.query.understand(input.tool.description),
    });
    const action = this.plannedActions.get(input.toolCallId);
    const inferredCapability = inferGenericCapabilities(input.tool)[0];
    const capability = action?.capability ?? inferredCapability;
    const matchingNeeds =
      action === undefined
        ? (this.lastContract?.contextNeeds ?? [])
            .filter(
              (need) =>
                this.lastContract?.toolPlan.resolutions?.some(
                  (resolution) =>
                    resolution.needId === need.id && resolution.toolNames.includes(input.tool.name),
                ) ?? false,
            )
            .map((need) => need.id)
        : [action.needId];
    let observation = {
      ...processed.observation,
      requestId: this.activeRequestId,
      ...(matchingNeeds.length === 0 ? {} : { needIds: matchingNeeds }),
      ...(capability === undefined ? {} : { capability }),
    };
    if (action) {
      observation = {
        ...observation,
        provenance: appendProvenance(
          observation.provenance,
          'retrieved',
          'adaptive-retrieval',
          action.priorOperationIds,
          {
            capability: action.capability,
            retrievalStrategy: action.strategy,
            reasonSelected: action.reason,
            resultStatus: observation.outcome,
            rawRequestId: action.requestId,
            contextNeedId: action.needId,
            ...(actualToolInput === undefined ? {} : { actualToolInput }),
            ...(action.retrievalInput === undefined
              ? {}
              : {
                  informationNeed: action.retrievalInput.informationNeed,
                  normalizedRetrievalRequest: action.retrievalInput.retrievalRequest,
                  retrievalArgument: action.retrievalInput.argumentName,
                  queryConstruction: action.retrievalInput.construction,
                  semanticallyCompacted: action.retrievalInput.semanticallyCompacted,
                  ...(action.retrievalInput.capabilityMaximumLength === undefined
                    ? {}
                    : {
                        capabilityInputMaximumLength:
                          action.retrievalInput.capabilityMaximumLength,
                      }),
                }),
            ...(action.adaptationReason === undefined
              ? {}
              : { adaptationReason: action.adaptationReason }),
            ...(action.previousStrategy === undefined
              ? {}
              : { previousStrategy: action.previousStrategy }),
          },
        ),
      };
    }
    const recalledArtifactId =
      action?.capability === 'ARTIFACT_READ' && typeof action.input.artifactId === 'string'
        ? action.input.artifactId
        : undefined;
    const recalledArtifact = this.offloadedState.find(
      (artifact) => artifact.artifactId === recalledArtifactId,
    );
    if (
      recalledArtifact &&
      (observation.outcome === 'success' || observation.outcome === 'partial') &&
      observation.content.trim().length > 0
    ) {
      observation = {
        ...observation,
        provenance: appendProvenance(
          {
            ...observation.provenance,
            parentIds: dedupeStrings([
              ...observation.provenance.parentIds,
              recalledArtifact.provenance.id,
            ]),
          },
          'recalled',
          'context-intelligence-engine',
          [recalledArtifact.provenance.id, observation.id],
          { artifactId: recalledArtifact.artifactId },
        ),
      };
      const wasOffloaded = recalledArtifact.lifecycleState === 'offloaded';
      recalledArtifact.lifecycleState = 'recalled';
      recalledArtifact.provenance = appendProvenance(
        recalledArtifact.provenance,
        'recalled',
        'context-intelligence-engine',
        [observation.id],
        { artifactId: recalledArtifact.artifactId },
      );
      if (wasOffloaded) {
        this.lifecycle.transition({
          requestId: this.activeRequestId,
          itemId: recalledArtifact.originalItemId ?? recalledArtifact.id,
          from: 'offloaded',
          to: 'recalled',
          reason: 'The actual offloaded artifact was retrieved and verified through the runtime.',
          component: 'context-intelligence-engine',
          metadata: { artifactId: recalledArtifact.artifactId },
        });
      }
    }
    this.observationState.push(observation);
    this.lifecycle.transition({
      requestId: this.activeRequestId,
      itemId: observation.id,
      to: 'observed',
      reason: `Runtime capability produced a ${observation.outcome} observation.`,
      component: 'observation-intelligence',
      metadata: {
        tool: observation.toolName,
        outcome: observation.outcome,
        capability: observation.capability ?? 'unclassified',
        retrievalStrategy: action?.strategy ?? 'unplanned',
      },
    });
    if (this.observationState.length > 100) this.observationState.shift();
    if (processed.offloaded) {
      this.offloadedState.push(processed.offloaded);
      if (this.offloadedState.length > 100) this.offloadedState.shift();
    }
    if (action) {
      const operation = this.runtimeOperations.find((entry) => entry.id === action.id);
      if (operation) {
        if (actualToolInput !== undefined) {
          operation.actualInput = structuredClone(actualToolInput);
        }
        const resourceOutcome = observeResourceOperation({
          action,
          observation,
          ...(input.output.metadata === undefined ? {} : { metadata: input.output.metadata }),
        });
        operation.status = runtimeOperationStatus(observation.outcome);
        operation.executionState = resourceOutcome.executionState;
        operation.retrievalState = retrievalStateForOutcome(observation.outcome);
        operation.resourceState = resourceOutcome.resourceState;
        if (resourceOutcome.resourceCandidates.length > 0) {
          operation.resourceCandidates = resourceOutcome.resourceCandidates;
        }
        operation.observationId = observation.id;
        const failureClassification =
          observation.failureClassification ??
          (observation.requiresFollowUp ? ('irrelevant' as const) : undefined);
        if (failureClassification !== undefined) {
          operation.failureClassification = failureClassification;
        }
        operation.completedAt = now();
        operation.durationMs = Math.max(
          0,
          Date.parse(operation.completedAt) - Date.parse(operation.startedAt),
        );
        if (
          executionDurationMs !== undefined &&
          Number.isFinite(executionDurationMs) &&
          executionDurationMs >= 0
        ) {
          operation.executionDurationMs = executionDurationMs;
        }
        const observedCost = observedCostFrom(input.output.metadata);
        if (observedCost) operation.observedCost = observedCost;
      }
    }
    if (this.taskState && (action || matchingNeeds.length > 0)) {
      this.taskState = this.tasks.recordObservation(this.taskState, {
        operationId: action?.id ?? input.toolCallId,
        receiptId: observation.id,
        executionState:
          (action
            ? this.runtimeOperations.find((operation) => operation.id === action.id)?.executionState
            : executionStateForOutcome(observation.outcome)) ?? 'NOT_EXECUTED',
        ...(observation.followUpReason === undefined ? {} : { issue: observation.followUpReason }),
      });
    }
    const observedOperation =
      action === undefined
        ? undefined
        : this.runtimeOperations.find((operation) => operation.id === action.id);
    this.emit('context-intelligence.observation', input, {
      tool: input.tool.name,
      outcome: observation.outcome,
      facts: observation.facts.length,
      identifiers: observation.identifiers.length,
      offloaded: Boolean(processed.offloaded),
      requiresFollowUp: observation.requiresFollowUp,
      retrieval_attempt_number: observedOperation?.iteration,
      retrieval_strategy: action?.strategy,
      retrieval_request: action?.retrievalInput?.retrievalRequest,
      actual_tool_input: actualToolInput,
      retrieval_state: observedOperation?.retrievalState,
      retrieval_failure_reason: observedOperation?.failureClassification,
      adaptation_reason: action?.adaptationReason,
      previous_strategy: action?.previousStrategy,
    });
    return {
      ...processed,
      observation,
      result: this.config.features.observationProcessing ? processed.result : input.output,
    };
  }

  bindRuntimeToolInput(input: {
    tool: Tool;
    toolCallId: string;
    proposedInput: unknown;
  }): { allowed: true; input: unknown } | { allowed: false; reason: string } {
    const action = this.plannedActions.get(input.toolCallId);
    if (action) {
      if (action.toolName !== input.tool.name) {
        return {
          allowed: false,
          reason: 'The runtime tool does not match the planned Context Intelligence capability.',
        };
      }
      if (stableHash(input.proposedInput) !== stableHash(action.input)) {
        return {
          allowed: false,
          reason:
            'The runtime capability input differs from the normalized retrieval input planned by Context Intelligence.',
        };
      }
      const trace = action.retrievalInput;
      if (
        trace &&
        action.input[trace.argumentName] !== trace.retrievalRequest
      ) {
        return {
          allowed: false,
          reason:
            'The planned capability input is inconsistent with its normalized retrieval request.',
        };
      }
      return { allowed: true, input: deepClone(action.input) };
    }

    const governedNeedIds = new Set(
      (this.lastContract?.toolPlan.resolutions ?? [])
        .filter((resolution) => resolution.toolNames.includes(input.tool.name))
        .map((resolution) => resolution.needId),
    );
    const governedRetrieval = (this.lastContract?.contextNeeds ?? []).some(
      (need) => governedNeedIds.has(need.id) && need.capabilityRequirement.readOnly,
    );
    const runtimeCapabilities =
      this.capabilities.registry.get(input.tool.name)?.provides ??
      input.tool.contextMetadata?.provides ??
      inferGenericCapabilities(input.tool);
    const retrievalCapability = runtimeCapabilities.some(
      (capability) =>
        capability !== 'MARKDOWN_ARTIFACT_CREATE' &&
        capability !== 'DOCUMENT_ARTIFACT_CREATE',
    );
    if (governedRetrieval || retrievalCapability) {
      return {
        allowed: false,
        reason:
          'Retrieval capabilities may execute only from a normalized Context Intelligence retrieval plan.',
      };
    }
    return { allowed: true, input: input.proposedInput };
  }

  reserveToolAction(input: {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    turnId: string;
  }): {
    allowed: boolean;
    used: number;
    limit: number;
    reason?: string;
  } {
    const limit = this.config.budgets.maxToolActions;
    if (this.toolActionCount >= limit) {
      return {
        allowed: false,
        used: this.toolActionCount,
        limit,
        reason: `Context Intelligence tool/action budget (${limit}) is exhausted.`,
      };
    }
    this.toolActionCount += 1;
    const plannedOperation = this.runtimeOperations.find(
      (operation) => operation.id === input.toolCallId && operation.status === 'planned',
    );
    if (plannedOperation) plannedOperation.retrievalState = 'IN_PROGRESS';
    this.emit('context-intelligence.lifecycle', input, {
      phase: 'tool-budget',
      tool: input.toolName,
      used: this.toolActionCount,
      limit,
      ...(plannedOperation === undefined
        ? {}
        : { retrieval_state: 'IN_PROGRESS', operation_id: plannedOperation.id }),
    });
    return { allowed: true, used: this.toolActionCount, limit };
  }

  async afterResponse(input: {
    message: AgentMessage;
    stopReason: StopReason;
    scope: ContextScope;
    memoryCandidates?: readonly MemoryCandidate[];
    sessionId: string;
    turnId: string;
  }): Promise<void> {
    const text = input.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    if (this.taskState && !input.message.content.some((block) => block.type === 'tool_call')) {
      const requestOperations = this.runtimeOperations.filter(
        (operation) => operation.requestId === this.activeRequestId,
      );
      const unresolvedOperations = requestOperations.filter(
        (operation, index) =>
          operation.executionState !== 'SUCCESS' &&
          !requestOperations.some(
            (retry, retryIndex) =>
              retryIndex > index &&
              retry.needId === operation.needId &&
              retry.phase === 'retrieval' &&
              retry.executionState === 'SUCCESS',
          ),
      );
      const qualityAccepted =
        this.lastContract?.directive.decision === 'ACCEPT' && this.lastContract.quality.sufficient;
      const unresolved = dedupeStrings([
        ...(this.lastContract?.quality.sufficient === false
          ? ['Context quality gate reported insufficiency.']
          : []),
        ...unresolvedOperations.map(
          (operation) =>
            `Operation ${operation.id} remained ${operation.executionState.toLowerCase()}.`,
        ),
      ]);
      this.taskState = this.tasks.complete(
        this.taskState,
        input.stopReason === 'end_turn' && qualityAccepted && unresolvedOperations.length === 0,
        unresolved,
      );
    }
    if (this.config.features.memory) {
      await this.updateActiveMemory(input.scope, text);
      for (const candidate of input.memoryCandidates ?? []) {
        const decision = await this.memory.admit(candidate, input.scope);
        if (
          this.config.features.boundedFeedback ||
          this.config.features.observedPerformanceOptimization ||
          this.config.features.evaluationMetrics
        ) {
          this.feedback.recordMemoryAdmission(
            this.activeRequestId,
            decision.candidate.id,
            decision.action,
          );
        }
        this.emit('context-intelligence.memory-admission', input, {
          type: candidate.type,
          action: decision.action,
          reason: decision.reason,
        });
      }
    }
  }

  snapshot(): PersistedContextIntelligenceState {
    const lastSnapshot = this.lastContract
      ? {
          version: 1 as const,
          requestId: this.lastContract.requestId,
          taskId: this.lastContract.taskState.taskId,
          decision: this.lastContract.directive.decision,
          qualityStatus: this.lastContract.quality.status,
          activeItemIds: this.lastContract.finalContext?.activeItemIds ?? [],
          evidenceIds: this.lastContract.evidence.map((item) => item.id),
          offloadedArtifactIds: this.lastContract.offloadedArtifacts.map(
            (artifact) => artifact.artifactId,
          ),
          lifecycleEventIds: this.lastContract.lifecycle.map((event) => event.id),
          updatedAt: this.lastContract.updatedAt,
        }
      : undefined;
    return {
      version: 1,
      ...(this.taskState === undefined ? {} : { taskState: deepClone(this.taskState) }),
      memories: this.memoryProvider.snapshot(),
      observations: deepClone(this.observationState.slice(-100)),
      offloadedArtifacts: deepClone(this.offloadedState.slice(-100)),
      recentOperations: deepClone(
        [...this.recentOperations, ...this.runtimeOperations.map(runtimeOperationSnapshot)].slice(
          -200,
        ),
      ),
      lifecycleEvents: deepClone(this.lifecycle.snapshot().slice(-500).map(lifecycleEventSnapshot)),
      ...(this.feedback.snapshot().length === 0
        ? {}
        : {
            feedback: deepClone(
              this.feedback.snapshot().slice(-this.config.p3.maximumFeedbackRecords),
            ),
          }),
      ...(this.performance.snapshot().length === 0
        ? {}
        : {
            performanceProfiles: deepClone(
              this.performance.snapshot().slice(-this.config.p3.maximumPerformanceProfiles),
            ),
          }),
      ...(this.lastEvaluation === undefined
        ? {}
        : { lastEvaluation: deepClone(this.lastEvaluation) }),
      ...(lastSnapshot === undefined ? {} : { lastSnapshot }),
      updatedAt: now(),
    };
  }

  private async updateActiveMemory(scope: ContextScope, responseText: string): Promise<void> {
    const timestamp = now();
    const existingShort = await this.memoryProvider.get(`short-term:${scope.taskId}`);
    const existingWorking = await this.memoryProvider.get(`working:${scope.taskId}`);
    const source = sourceMetadata({
      id: `session:${scope.conversationId}`,
      name: 'Current session state',
      type: 'memory',
      sourceKind: 'MEMORY',
      authority: 0.8,
      observedAt: timestamp,
    });
    const common = {
      scope: deepClone(scope),
      labels: ['context-intelligence'],
      entities: this.lastContract?.intent.entities.map((entity) => entity.value) ?? [],
      relevance: 1,
      confidence: 0.9,
      authority: 0.8,
      durability: 0.2,
      usefulness: 0.8,
      privacy: 'internal' as const,
      provenance: provenance(source, 'received', 'post-response-memory'),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      status: 'active' as const,
    };
    const shortTerm: MemoryItem = {
      id: `short-term:${scope.taskId}`,
      type: 'short-term',
      layer: 'task',
      ...common,
      content: [existingShort?.content, responseText].filter(Boolean).join('\n').slice(-3_000),
      createdAt: existingShort?.createdAt ?? timestamp,
      version: (existingShort?.version ?? 0) + 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    };
    const working: MemoryItem = {
      id: `working:${scope.taskId}`,
      type: 'working',
      layer: 'working',
      ...common,
      content: this.taskState ? renderWorkingState(this.taskState) : 'No active task state.',
      ...(this.taskState === undefined ? {} : { structured: deepClone(this.taskState) }),
      createdAt: existingWorking?.createdAt ?? timestamp,
      version: (existingWorking?.version ?? 0) + 1,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    };
    await this.memoryProvider.upsert(shortTerm);
    await this.memoryProvider.upsert(working);
  }

  private async prepareQuery(
    request: string,
    scope: ContextScope,
    signal: AbortSignal,
    needs: readonly ContextNeed[],
  ) {
    const intent = this.query.understand(request);
    const plan = this.config.features.queryIntelligence
      ? await this.query.plan(request, signal)
      : {
          id: id('query_plan'),
          originalRequest: request,
          normalizedQuery: intent.normalizedRequest,
          variants: [
            {
              id: id('query'),
              original: request,
              query: intent.normalizedRequest,
              kind: 'original' as const,
              dependencyIds: [],
              expectedEvidence: intent.entities.map((entity) => entity.value),
              sourceHints: [],
              status: 'pending' as const,
              resultIds: [],
              attempts: 0,
            },
          ],
          synthesisOrder: [],
          createdAt: now(),
        };
    const evidenceRequired = needs.some(
      (need) => need.required && need.evidenceRequirement === 'REQUIRED',
    );
    const allowedSourceKinds = dedupeStrings(
      needs
        .filter((need) => need.required && need.evidenceRequirement === 'REQUIRED')
        .flatMap((need) => need.sourceKinds),
    ) as ContextContract['contextNeeds'][number]['sourceKinds'];
    const providerCount = this.retrievalRegistry
      .list()
      .filter((provider) => provider.metadata.executionBoundary !== 'runtime_tool').length;
    const retrieve =
      this.config.features.retrieval &&
      providerCount > 0 &&
      (evidenceRequired || shouldRetrieve(intent, this.observationState, providerCount));
    const retrievedOutcome = retrieve
      ? await this.retrieval.retrieve({
          plan,
          intent,
          scope,
          signal,
          ...(allowedSourceKinds.length === 0 ? {} : { allowedSourceKinds }),
        })
      : {
          results: [],
          iterations: [],
          conflicts: [],
          sufficient: !evidenceRequired,
          insufficiencies: evidenceRequired
            ? [
                providerCount === 0
                  ? 'no retrieval provider; resolve through runtime capabilities'
                  : 'retrieval was not available',
              ]
            : [],
        };
    const outcome = await this.applyDocumentIntelligence(
      retrievedOutcome,
      intent.normalizedRequest,
      signal,
    );
    return { intent, plan, outcome, synthesis: this.query.synthesize(plan, outcome.results) };
  }

  private async applyDocumentIntelligence(
    outcome: ContextContract['retrieval'],
    query: string,
    signal: AbortSignal,
  ): Promise<ContextContract['retrieval']> {
    if (!this.config.features.chunking) return outcome;
    const results = [];
    for (const result of outcome.results) {
      if (
        result.source.type !== 'document' ||
        estimateTokens(result.content) <= this.config.chunking.maximumTokens
      ) {
        results.push(result);
        continue;
      }
      try {
        const chunks = await this.chunking.chunk(
          {
            id: result.id,
            content: result.content,
            contentType: String(result.metadata.contentType ?? 'text/plain'),
            source: result.source,
            metadata: result.metadata,
            structure:
              result.metadata.structure === 'sections' ||
              result.metadata.structure === 'hierarchical' ||
              result.metadata.structure === 'tabular' ||
              result.metadata.structure === 'code' ||
              result.metadata.structure === 'flat'
                ? result.metadata.structure
                : 'unknown',
          },
          { phase: 'post', query, signal },
        );
        const selected = [...chunks]
          .filter((chunk) => chunk.level > 0 || !chunk.children.length)
          .sort(
            (left, right) =>
              lexicalSimilarity(query, right.content) - lexicalSimilarity(query, left.content),
          )
          .slice(0, 6);
        const content = selected
          .map(
            (chunk) =>
              `${chunk.headingPath.length ? `${chunk.headingPath.join(' > ')}\n` : ''}${
                chunk.content
              } [chunk:${chunk.id}]`,
          )
          .join('\n\n');
        results.push({
          ...result,
          content,
          structured: {
            chunkCount: chunks.length,
            selectedChunkIds: selected.map((chunk) => chunk.id),
            documentId: result.id,
          },
          provenance: appendProvenance(
            result.provenance,
            'shaped',
            'document-post-chunking',
            selected.map((chunk) => chunk.id),
          ),
        });
      } catch {
        results.push(result);
      }
    }
    return { ...outcome, results };
  }

  private async allCapabilities(
    intent: ContextContract['intent'],
    tools: readonly Tool[],
    needs: readonly ContextNeed[],
    excludeToolNames: readonly string[] = [],
  ) {
    const temporary = new CapabilityIntelligence(
      {
        ...this.config.capability,
        relevanceThreshold: 0,
        minimumExposed: tools.length,
        maximumExposed: tools.length,
      },
      [],
      [],
      this.config.features.observedPerformanceOptimization,
      this.config.p3.minimumComparableSamples,
    );
    return temporary.select(intent, tools, needs, {
      excludeToolNames,
      ...(this.config.features.observedPerformanceOptimization
        ? { performanceProfiles: this.performance.snapshot() }
        : {}),
    });
  }

  private registerRuntimeActions(actions: readonly ContextRuntimeAction[]): void {
    for (const action of actions) {
      if (this.plannedActions.has(action.id)) continue;
      this.plannedActions.set(action.id, action);
      this.runtimeOperations.push({
        id: action.id,
        requestId: action.requestId,
        needId: action.needId,
        capability: action.capability,
        phase: action.phase,
        toolName: action.toolName,
        input: deepClone(action.input),
        attemptKey: action.attemptKey,
        strategy: action.strategy,
        ...(action.retrievalInput === undefined
          ? {}
          : { retrievalInput: deepClone(action.retrievalInput) }),
        ...(action.adaptationReason === undefined
          ? {}
          : { adaptationReason: action.adaptationReason }),
        ...(action.previousStrategy === undefined
          ? {}
          : { previousStrategy: action.previousStrategy }),
        iteration: action.iteration,
        status: 'planned',
        executionState: 'NOT_EXECUTED',
        retrievalState: action.priorOperationIds.length > 0 ? 'RETRYING' : 'NOT_EXECUTED',
        resourceState: 'NOT_CHECKED',
        startedAt: now(),
      });
      if (this.taskState) {
        this.taskState = this.tasks.recordPlanned(this.taskState, action.id);
      }
    }
  }

  private emit(
    event: ContextIntelligenceTelemetryEvent['event'],
    input: { sessionId: string; turnId?: string },
    data: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.onTelemetry?.({
        event,
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        data,
      });
    } catch {
      // Telemetry must remain fail-open.
    }
  }
}

function reasoningSupport(
  intent: ContextContract['intent'],
  taskState: ContextContract['taskState'],
  selectedCapabilities: number,
  queryPlan: ContextContract['queryPlan'],
  config: ContextIntelligenceConfig,
): ReasoningSupport {
  const mode =
    config.reasoning.mode !== 'auto'
      ? config.reasoning.mode
      : !config.features.advancedReasoning
        ? 'direct'
        : intent.complexity === 'complex'
          ? 'tree'
          : selectedCapabilities > 0
            ? 'react'
            : 'alternatives';
  const alternatives = queryPlan.variants
    .filter((query) => query.kind !== 'original')
    .slice(0, config.reasoning.maximumAlternatives)
    .map((query, index) => ({
      id: query.id,
      description: `${query.kind}: ${query.query}`,
      score: Math.max(0.1, 1 - index * 0.15),
      selected: index === 0,
    }));
  return {
    mode,
    examples: config.reasoning.examples,
    alternatives,
    plan: taskState.plan.map((step) => step.description),
    decisions: [],
    unresolvedIssues: taskState.unresolvedIssues,
  };
}

function dedupeProvenance(values: readonly ContextContract['provenance'][number][]) {
  const records = new Map(values.map((value) => [value.id, value]));
  return [...records.values()];
}

function dedupeSources(sources: readonly ContextContract['sources'][number][]) {
  const values = new Map(sources.map((source) => [source.id, source]));
  return [...values.values()];
}

function renderWorkingState(state: NonNullable<ContextContract['taskState']>): string {
  return [
    `Goal: ${state.goal}`,
    `Status: ${state.status}`,
    `Completed: ${state.completedSteps.join(', ') || 'none'}`,
    `Pending: ${state.pendingSteps.join(', ') || 'none'}`,
    `Decisions: ${state.pendingDecisions.join('; ') || 'none'}`,
    `Issues: ${state.unresolvedIssues.join('; ') || 'none'}`,
  ].join('\n');
}

function shouldRetrieve(
  intent: ContextContract['intent'],
  observations: readonly ToolObservation[],
  providerCount: number,
): boolean {
  if (providerCount === 0) return false;
  if (observations.some((observation) => observation.requiresFollowUp)) return true;
  if (intent.temporal?.requiresCurrentData) return true;
  if (
    /\b(search|find|look up|lookup|retrieve|source|evidence|verify|current|latest|record|document|dataset|database|knowledge|policy|procedure)\b/i.test(
      intent.originalRequest,
    )
  ) {
    return true;
  }
  return intent.operation === 'answer' && intent.entities.length > 0;
}

function runtimeOperationSnapshot(operation: RuntimeRetrievalOperation): RuntimeOperationSnapshot {
  const {
    input: _contentBearingInput,
    actualInput: _contentBearingActualInput,
    resourceCandidates: _contentBearingCandidates,
    ...snapshot
  } = operation;
  return deepClone(snapshot);
}

function lifecycleEventSnapshot(
  event: ContextContract['lifecycle'][number],
): ContextLifecycleSnapshot {
  const { reason, metadata: _contentBearingMetadata, ...snapshot } = event;
  return {
    ...snapshot,
    reasonCode: lifecycleReasonCode(reason),
  };
}

function restoreLifecycleEvents(
  snapshots: readonly ContextLifecycleSnapshot[],
): ContextContract['lifecycle'] {
  return snapshots.map(({ reasonCode, ...snapshot }) => ({
    ...snapshot,
    reason: reasonCode,
    metadata: { restoredFromContentFreeSnapshot: true },
  }));
}

function lifecycleReasonCode(reason: string): string {
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'unspecified'
  );
}

function observedCostFrom(
  metadata: Record<string, unknown> | undefined,
): RuntimeRetrievalOperation['observedCost'] | undefined {
  const candidate = metadata?.observedCost;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.amount !== 'number' ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    typeof value.unit !== 'string' ||
    !value.unit.trim()
  ) {
    return undefined;
  }
  return {
    amount: value.amount,
    unit: value.unit.trim().toLowerCase().slice(0, 50),
    source: 'tool_result_metadata',
  };
}

function runtimeOperationStatus(
  outcome: ToolObservation['outcome'],
): RuntimeRetrievalOperation['status'] {
  if (outcome === 'success' || outcome === 'partial') return 'succeeded';
  if (outcome === 'empty') return 'empty';
  if (outcome === 'denied') return 'denied';
  return 'failed';
}

function executionStateForOutcome(
  outcome: ToolObservation['outcome'],
): NonNullable<ContextContract['taskState']['executionHistory'][number]['state']> {
  if (outcome === 'success' || outcome === 'partial') return 'SUCCESS';
  if (outcome === 'empty') return 'EMPTY';
  if (outcome === 'denied') return 'BLOCKED';
  return 'FAILED';
}

function retrievalStateForOutcome(
  outcome: ToolObservation['outcome'],
): NonNullable<RuntimeRetrievalOperation['retrievalState']> {
  if (outcome === 'success' || outcome === 'partial') return 'SUCCESS';
  if (outcome === 'empty') return 'EMPTY';
  if (outcome === 'denied') return 'BLOCKED';
  return 'FAILED';
}

export function insufficientQualityReport(reason: string): ContextQualityReport {
  return {
    status: 'insufficient',
    decision: 'ABSTAIN',
    score: 0,
    issues: [
      {
        code: 'missing_evidence',
        severity: 'error',
        itemIds: [],
        message: reason,
        remediation: 'retrieve',
      },
    ],
    conflicts: [],
    sufficient: false,
    checkedAt: now(),
  };
}

export function estimatedContractTokens(contract: ContextContract): number {
  return estimateTokens(contract.finalContext?.systemPromptAddition ?? '');
}

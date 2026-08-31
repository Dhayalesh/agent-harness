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
import { EvidenceIntelligence } from './evidence-intelligence.js';
import { ContextQualityGate } from './quality-gate.js';
import { RuntimeRetrievalPlanner } from './runtime-retrieval.js';
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
    | 'context-intelligence.hygiene'
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
  private readonly needs = new ContextNeedIntelligence();
  private readonly evidence: EvidenceIntelligence;
  private readonly qualityGate: ContextQualityGate;
  private readonly runtimeRetrieval: RuntimeRetrievalPlanner;
  private readonly tasks = new TaskStateManager();
  private readonly onTelemetry: ((event: ContextIntelligenceTelemetryEvent) => void) | undefined;
  private taskState: ContextContract['taskState'] | undefined;
  private observationState: ToolObservation[];
  private offloadedState: ContextContract['offloadedArtifacts'][number][];
  private lastContract: ContextContract | undefined;
  private toolActionCount = 0;
  private activeRequestId = id('request');
  private requestStartedAt = Date.now();
  private runtimeOperations: RuntimeRetrievalOperation[] = [];
  private readonly plannedActions = new Map<string, ContextRuntimeAction>();

  constructor(options: ContextIntelligenceEngineOptions = {}) {
    this.taskState = options.initialState?.taskState;
    this.observationState = [...(options.initialState?.observations ?? [])];
    this.offloadedState = [...(options.initialState?.offloadedArtifacts ?? [])];
    this.lastContract = options.initialState?.lastContract;
    this.config = resolveContextIntelligenceConfig(options.config);
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
    );
    this.observations = new ObservationIntelligence(this.config, options.artifactStore);
    this.hygiene = new ContextHygieneEngine(this.config, options.semanticSummarizer);
    this.offloader = new ContextOffloader(options.artifactStore);
    this.finalizer = new ContextFinalizer(this.config);
    this.evidence = new EvidenceIntelligence(this.config);
    this.qualityGate = new ContextQualityGate(this.config);
    this.runtimeRetrieval = new RuntimeRetrievalPlanner(this.config);
    this.chunking = new ChunkingIntelligence(this.config.chunking, options.chunkingStrategies);
    this.onTelemetry = options.onTelemetry;
  }

  async prepare(input: PrepareContextIntelligenceInput): Promise<PrepareContextIntelligenceResult> {
    const started = Date.now();
    const intent = this.query.understand(input.request);
    const initialNeeds = this.needs.identify(intent, input.scope, this.activeRequestId);
    const taskState = this.tasks.recover(this.taskState, intent, input.scope.taskId);
    this.taskState = taskState;
    const memories = this.config.features.memory
      ? await this.memory.recall(intent, input.scope, input.signal)
      : [];
    this.emit('context-intelligence.memory-recall', input, {
      recalled: memories.length,
      types: [...new Set(memories.map((memory) => memory.type))],
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

    const toolPlan = this.config.features.capabilityNarrowing
      ? await this.capabilities.select(intent, input.tools, initialNeeds)
      : await this.allCapabilities(intent, input.tools, initialNeeds);
    this.emit('context-intelligence.capability-selection', input, {
      available: input.tools.length,
      selected: toolPlan.selected.length,
      names: toolPlan.selected.map((entry) => entry.capability.name),
    });
    const observationEvidence = this.evidence.admit({
      requestId: this.activeRequestId,
      intent,
      needs: initialNeeds,
      observations: this.observationState,
    });
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
    const offloadedArtifacts = [...this.offloadedState];
    const preHygiene = [];
    for (const item of synthesis.items) {
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
        if (offloaded.artifact) offloadedArtifacts.push(offloaded.artifact);
      } else preHygiene.push(item);
    }
    this.offloadedState = offloadedArtifacts.slice(-100);
    const hygiene = await this.hygiene.process(preHygiene, input.signal, input.scope);
    const retainedIds = new Set(hygiene.items.map((item) => item.id));
    const admittedEvidence = synthesis.evidence.filter((item) => retainedIds.has(item.id));
    const contextNeeds = this.needs.assess(initialNeeds, admittedEvidence, toolPlan.resolutions);
    const evidenceNeeds = contextNeeds.filter(
      (need) => need.required && need.evidenceRequirement === 'REQUIRED',
    );
    const evidenceSufficient = evidenceNeeds.every((need) => need.status === 'satisfied');
    const effectiveRetrieval = {
      ...queryResult.outcome,
      sufficient: evidenceSufficient,
      insufficiencies: evidenceSufficient
        ? []
        : dedupeStrings([
            ...queryResult.outcome.insufficiencies,
            ...evidenceNeeds
              .filter((need) => need.status !== 'satisfied')
              .flatMap((need) => need.missingInformation),
          ]),
    };
    const runtimeActions = this.runtimeRetrieval.plan({
      requestId: this.activeRequestId,
      intent,
      needs: contextNeeds,
      toolPlan,
      observations: this.observationState,
      operations: this.runtimeOperations,
      elapsedMs: Date.now() - this.requestStartedAt,
    });
    this.registerRuntimeActions(runtimeActions);
    const combinedConflicts = [...queryResult.outcome.conflicts, ...hygiene.conflicts];
    const qualityGate = this.qualityGate.evaluate({
      report: { ...hygiene.report, conflicts: combinedConflicts },
      needs: contextNeeds,
      actions: runtimeActions,
      operations: this.runtimeOperations,
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
      items: hygiene.items,
      messages: input.messages,
      tools: selectedTools,
      quality: qualityGate.report,
      offloadedArtifacts: this.offloadedState,
      inputLimit: input.inputLimit,
      outputReservation: input.outputReservation,
      systemPrompt: input.systemPrompt,
    });
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
      evidence: admittedEvidence,
      sources: dedupeSources(hygiene.items.map((item) => item.source)),
      conflicts: combinedConflicts,
      capabilities: toolPlan.selected,
      toolPlan,
      observations: deepClone(this.observationState),
      findings: hygiene.items.filter((item) => item.kind === 'finding'),
      taskState,
      queryPlan: queryResult.plan,
      retrieval: effectiveRetrieval,
      runtimeRetrieval: deepClone(this.runtimeOperations),
      reasoning,
      budget: finalized.budget,
      provenance: hygiene.items.map((item) => item.provenance),
      items: hygiene.items,
      offloadedArtifacts: deepClone(this.offloadedState),
      finalContext: finalized,
      quality: qualityGate.report,
      directive: qualityGate.directive,
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
      sections: finalized.sections.length,
      tools: finalized.tools.length,
      inputTokens: finalized.budget.usedInput,
      omittedItems: finalized.omittedItemIds.length,
      quality: finalized.quality.status,
      durationMs: Date.now() - started,
    });
    return { contract, finalized };
  }

  beginRequest(): void {
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
  }): Promise<ProcessedObservation> {
    const processed = await this.observations.process({
      ...input,
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
    const observation = {
      ...processed.observation,
      requestId: this.activeRequestId,
      ...(matchingNeeds.length === 0 ? {} : { needIds: matchingNeeds }),
      ...(capability === undefined ? {} : { capability }),
    };
    this.observationState.push(observation);
    if (this.observationState.length > 100) this.observationState.shift();
    if (processed.offloaded) {
      this.offloadedState.push(processed.offloaded);
      if (this.offloadedState.length > 100) this.offloadedState.shift();
    }
    if (action) {
      const operation = this.runtimeOperations.find((entry) => entry.id === action.id);
      if (operation) {
        operation.status = runtimeOperationStatus(observation.outcome);
        operation.observationId = observation.id;
      }
    }
    if (this.taskState) {
      this.taskState = this.tasks.recordObservation(this.taskState, {
        receiptId: observation.id,
        successful: observation.outcome === 'success' || observation.outcome === 'partial',
        requiresFollowUp: observation.requiresFollowUp,
        ...(observation.followUpReason === undefined ? {} : { issue: observation.followUpReason }),
      });
    }
    this.emit('context-intelligence.observation', input, {
      tool: input.tool.name,
      outcome: observation.outcome,
      facts: observation.facts.length,
      identifiers: observation.identifiers.length,
      offloaded: Boolean(processed.offloaded),
      requiresFollowUp: observation.requiresFollowUp,
    });
    return {
      ...processed,
      observation,
      result: this.config.features.observationProcessing ? processed.result : input.output,
    };
  }

  reserveToolAction(input: { toolName: string; sessionId: string; turnId: string }): {
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
    this.emit('context-intelligence.lifecycle', input, {
      phase: 'tool-budget',
      tool: input.toolName,
      used: this.toolActionCount,
      limit,
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
      this.taskState = this.tasks.complete(
        this.taskState,
        input.stopReason === 'end_turn',
        this.lastContract?.quality.sufficient === false
          ? ['Context quality gate reported insufficiency.']
          : [],
      );
    }
    if (this.config.features.memory) {
      await this.updateActiveMemory(input.scope, text);
      for (const candidate of input.memoryCandidates ?? []) {
        const decision = await this.memory.admit(candidate, input.scope);
        this.emit('context-intelligence.memory-admission', input, {
          type: candidate.type,
          action: decision.action,
          reason: decision.reason,
        });
      }
    }
  }

  snapshot(): PersistedContextIntelligenceState {
    return {
      version: 1,
      ...(this.taskState === undefined ? {} : { taskState: deepClone(this.taskState) }),
      memories: this.memoryProvider.snapshot(),
      observations: deepClone(this.observationState.slice(-100)),
      offloadedArtifacts: deepClone(this.offloadedState.slice(-100)),
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
      type: 'conversation',
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
      ...common,
      content: [existingShort?.content, responseText].filter(Boolean).join('\n').slice(-3_000),
      createdAt: existingShort?.createdAt ?? timestamp,
      version: (existingShort?.version ?? 0) + 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    };
    const working: MemoryItem = {
      id: `working:${scope.taskId}`,
      type: 'working',
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
    const providerCount = this.retrievalRegistry.list().length;
    const retrieve =
      this.config.features.retrieval &&
      providerCount > 0 &&
      (evidenceRequired || shouldRetrieve(intent, this.observationState, providerCount));
    const retrievedOutcome = retrieve
      ? await this.retrieval.retrieve({ plan, intent, scope, signal })
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
  ) {
    const temporary = new CapabilityIntelligence({
      ...this.config.capability,
      relevanceThreshold: 0,
      minimumExposed: tools.length,
      maximumExposed: tools.length,
    });
    return temporary.select(intent, tools, needs);
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
        toolName: action.toolName,
        input: deepClone(action.input),
        iteration: action.iteration,
        status: 'planned',
      });
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

function runtimeOperationStatus(
  outcome: ToolObservation['outcome'],
): RuntimeRetrievalOperation['status'] {
  if (outcome === 'success' || outcome === 'partial') return 'succeeded';
  if (outcome === 'empty') return 'empty';
  if (outcome === 'denied') return 'denied';
  return 'failed';
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

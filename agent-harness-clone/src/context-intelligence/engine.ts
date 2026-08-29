import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { AgentMessage } from '../core/messages.js';
import type { StopReason } from '../models/provider.js';
import type { Tool, ToolExecutionResult } from '../tools/tool.js';
import { CapabilityIntelligence, type CapabilityMetadataProvider } from './capability-intelligence.js';
import { ChunkingIntelligence, type ChunkingStrategy } from './chunking.js';
import {
  resolveContextIntelligenceConfig,
  type ContextIntelligenceConfig,
  type ContextIntelligenceConfigInput,
} from './config.js';
import type {
  CapabilityMetadata,
  ContextContract,
  ContextQualityReport,
  ContextScope,
  FinalizedContext,
  MemoryItem,
  PersistedContextIntelligenceState,
  ReasoningSupport,
  RetrievalProvider,
  RetrievalReranker,
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
  private readonly tasks = new TaskStateManager();
  private readonly onTelemetry: ((event: ContextIntelligenceTelemetryEvent) => void) | undefined;
  private taskState: ContextContract['taskState'] | undefined;
  private observationState: ToolObservation[];
  private offloadedState: ContextContract['offloadedArtifacts'][number][];
  private lastContract: ContextContract | undefined;
  private toolActionCount = 0;

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
    this.chunking = new ChunkingIntelligence(this.config.chunking, options.chunkingStrategies);
    this.onTelemetry = options.onTelemetry;
  }

  async prepare(input: PrepareContextIntelligenceInput): Promise<PrepareContextIntelligenceResult> {
    const started = Date.now();
    const intent = this.query.understand(input.request);
    const taskState = this.tasks.recover(this.taskState, intent, input.scope.taskId);
    this.taskState = taskState;
    const memories = this.config.features.memory
      ? await this.memory.recall(intent, input.scope, input.signal)
      : [];
    this.emit('context-intelligence.memory-recall', input, {
      recalled: memories.length,
      types: [...new Set(memories.map((memory) => memory.type))],
    });

    const queryResult = await this.prepareQuery(input.request, input.scope, input.signal);
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
      ? await this.capabilities.select(intent, input.tools)
      : await this.allCapabilities(intent, input.tools);
    this.emit('context-intelligence.capability-selection', input, {
      available: input.tools.length,
      selected: toolPlan.selected.length,
      names: toolPlan.selected.map((entry) => entry.capability.name),
    });
    const synthesis = this.synthesizer.synthesize({
      request: input.request,
      intent,
      scope: input.scope,
      messages: input.messages,
      memories,
      retrieval: queryResult.outcome,
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
          item.kind === 'history' ? 'history' : item.kind === 'evidence' ? 'document' : 'intermediate',
          input.sessionId,
        );
        preHygiene.push(offloaded.item);
        if (offloaded.artifact) offloadedArtifacts.push(offloaded.artifact);
      } else preHygiene.push(item);
    }
    this.offloadedState = offloadedArtifacts.slice(-100);
    const hygiene = await this.hygiene.process(preHygiene, input.signal, input.scope);
    this.emit('context-intelligence.hygiene', input, {
      candidates: preHygiene.length,
      retained: hygiene.items.length,
      pruned: hygiene.prunedItemIds.length,
      compressed: hygiene.compressedItemIds.length,
      conflicts: hygiene.conflicts.length,
      quality: hygiene.report.status,
      score: hygiene.report.score,
    });
    const selectedTools = toolPlan.selected
      .map((entry) => entry.descriptor)
      .filter((descriptor): descriptor is NonNullable<typeof descriptor> => descriptor !== undefined);
    const finalized = this.finalizer.finalize({
      items: hygiene.items,
      messages: input.messages,
      tools: selectedTools,
      quality: hygiene.report,
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
      requestId: id('request'),
      scope: deepClone(input.scope),
      rawRequest: input.request,
      intent,
      constraints: intent.constraints,
      requiredEntities: intent.entities.filter((entity) => entity.required),
      ...(intent.temporal === undefined ? {} : { temporal: intent.temporal }),
      memories,
      evidence: synthesis.evidence,
      sources: dedupeSources(hygiene.items.map((item) => item.source)),
      conflicts: [...queryResult.outcome.conflicts, ...hygiene.conflicts],
      capabilities: toolPlan.selected,
      toolPlan,
      observations: deepClone(this.observationState),
      findings: hygiene.items.filter((item) => item.kind === 'finding'),
      taskState,
      queryPlan: queryResult.plan,
      retrieval: queryResult.outcome,
      reasoning,
      budget: finalized.budget,
      provenance: hygiene.items.map((item) => item.provenance),
      items: hygiene.items,
      offloadedArtifacts: deepClone(this.offloadedState),
      finalContext: finalized,
      quality: hygiene.report,
      pendingDecisions: dedupeStrings([
        ...taskState.pendingDecisions,
        ...intent.ambiguity,
        ...hygiene.conflicts
          .filter((conflict) => conflict.resolution === 'unresolved')
          .map((conflict) => conflict.explanation),
      ]),
      createdAt: this.lastContract?.scope.taskId === input.scope.taskId ? this.lastContract.createdAt : timestamp,
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
  }

  async processObservation(input: {
    tool: Tool;
    toolCallId: string;
    output: ToolExecutionResult;
    sessionId: string;
    turnId: string;
  }): Promise<ProcessedObservation> {
    if (!this.config.features.observationProcessing) {
      const fallback = await this.observations.process({
        ...input,
        intent: this.lastContract?.intent ?? this.query.understand(input.tool.description),
      });
      return { ...fallback, result: input.output };
    }
    const processed = await this.observations.process({
      ...input,
      intent: this.lastContract?.intent ?? this.query.understand(input.tool.description),
    });
    this.observationState.push(processed.observation);
    if (this.observationState.length > 100) this.observationState.shift();
    if (processed.offloaded) {
      this.offloadedState.push(processed.offloaded);
      if (this.offloadedState.length > 100) this.offloadedState.shift();
    }
    if (this.taskState) {
      this.taskState = this.tasks.recordObservation(this.taskState, {
        receiptId: processed.observation.id,
        successful: processed.observation.outcome === 'success' || processed.observation.outcome === 'partial',
        requiresFollowUp: processed.observation.requiresFollowUp,
        ...(processed.observation.followUpReason === undefined
          ? {}
          : { issue: processed.observation.followUpReason }),
      });
    }
    this.emit('context-intelligence.observation', input, {
      tool: input.tool.name,
      outcome: processed.observation.outcome,
      facts: processed.observation.facts.length,
      identifiers: processed.observation.identifiers.length,
      offloaded: Boolean(processed.offloaded),
      requiresFollowUp: processed.observation.requiresFollowUp,
    });
    return processed;
  }

  reserveToolAction(input: {
    toolName: string;
    sessionId: string;
    turnId: string;
  }): { allowed: boolean; used: number; limit: number; reason?: string } {
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
        this.lastContract?.quality.sufficient === false ? ['Context quality gate reported insufficiency.'] : [],
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
      content: [existingShort?.content, responseText]
        .filter(Boolean)
        .join('\n')
        .slice(-3_000),
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

  private async prepareQuery(request: string, scope: ContextScope, signal: AbortSignal) {
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
    const retrieve =
      this.config.features.retrieval &&
      shouldRetrieve(intent, this.observationState, this.retrievalRegistry.list().length);
    const retrievedOutcome = retrieve
      ? await this.retrieval.retrieve({ plan, intent, scope, signal })
      : {
          results: [],
          iterations: [],
          conflicts: [],
          sufficient: true,
          insufficiencies: [],
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
              lexicalSimilarity(query, right.content) -
              lexicalSimilarity(query, left.content),
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

  private async allCapabilities(intent: ContextContract['intent'], tools: readonly Tool[]) {
    const temporary = new CapabilityIntelligence({
      ...this.config.capability,
      relevanceThreshold: 0,
      minimumExposed: tools.length,
      maximumExposed: tools.length,
    });
    return temporary.select(intent, tools);
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

export function insufficientQualityReport(reason: string): ContextQualityReport {
  return {
    status: 'insufficient',
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

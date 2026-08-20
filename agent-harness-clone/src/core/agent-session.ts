import { randomUUID } from 'node:crypto';
import { AgentAbortError, AgentHarnessError, errorMessage } from './errors.js';
import type { AgentEvent, EventPayload } from './events.js';
import type { AgentInput, AgentMessage, ToolCallBlock, ToolResultBlock } from './messages.js';
import { textMessage, userMessage } from './messages.js';
import {
  contextPolicyFromPercent,
  DynamicCompactingContextManager,
  estimateMessagesTokens,
  type ContextManager,
  type ModelContextCapabilities,
} from '../context/context-manager.js';
import { HookRegistry } from '../hooks/hooks.js';
import type { ModelProvider, StopReason } from '../models/provider.js';
import {
  DefaultPermissionHandler,
  type PermissionDecision,
  type PermissionHandler,
} from '../permissions/permission-handler.js';
import { ToolRegistry } from '../tools/registry.js';
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPermissionCheck,
} from '../tools/tool.js';
import { AsyncEventQueue } from './event-queue.js';
import type { SessionStore, StoredSession } from '../sessions/session-store.js';
import type { CommandRegistry } from '../commands/commands.js';
import type { Artifact, ArtifactStore } from '../artifacts/artifact-store.js';
import {
  emitLog,
  type EventSink,
  type LogContext,
  type LogSink,
} from '../services/observability.js';
import { BudgetTracker, type BudgetLimits, type SessionRateLimiter } from '../services/limits.js';
import { formatProjectContext, type ProjectContextProvider } from '../context/project-context.js';

export type AgentLimits = {
  maxTurns: number;
  maxOutputTokens?: number;
  /**
   * How full the derived input budget may get, as a percentage, before the
   * context layer summarises older turns out of the request.
   *
   * A percentage rather than a token ceiling because the budget itself belongs to
   * the model: it is the provider's context window less the reserved reply. An
   * absolute ceiling has to be restated every time the model changes and is
   * silently catastrophic when it is set too low, where a percentage is
   * self-limiting by construction.
   */
  compactionThresholdPercent?: number;
};

export type AgentSessionConfig = {
  provider: ModelProvider;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  tools?: readonly Tool[] | ToolRegistry;
  permissionHandler?: PermissionHandler;
  contextManager?: ContextManager;
  hooks?: HookRegistry;
  sessionStore?: SessionStore;
  sessionId?: string;
  initialMessages?: readonly AgentMessage[];
  sessionCreatedAt?: string;
  sessionState?: {
    mode: 'persistent' | 'stateless';
    storage?: 'none' | 'memory' | 'file' | 's3' | 'custom';
    resumed: boolean;
    origin: 'new' | 'store' | 'client_history' | 'stateless';
  };
  metadata?: Record<string, unknown>;
  commands?: CommandRegistry;
  artifactStore?: ArtifactStore;
  maxInlineToolResultChars?: number;
  eventSink?: EventSink;
  /** Detailed model and AgentEvent records; failures are always fail-open. */
  logSink?: LogSink;
  /** Correlation fields copied onto every structured record. */
  logContext?: LogContext;
  budget?: BudgetLimits;
  rateLimiter?: SessionRateLimiter;
  projectContextProvider?: ProjectContextProvider;
  limits?: Partial<AgentLimits>;
  /**
   * Model context capabilities (contextWindow, maxOutputTokens) used to derive
   * a dynamic input budget in the context manager. When supplied, the context
   * manager adapts automatically to models of different sizes without requiring
   * any application-level hardcoding.
   */
  modelCapabilities?: ModelContextCapabilities;
  /**
   * Compact the context on this run's first turn, whatever the thresholds say.
   *
   * For a client that offers "compact context" as an action. It applies once: the
   * turns after it are governed by the policy again, so asking for compaction does
   * not put the session into a permanently compacting mode.
   */
  compactContext?: boolean;
  /**
   * Where this session's `sequence` numbering starts.
   *
   * A transport that emitted its own events before the session began — the
   * preparation a headless run reports — passes the count it already used, so the
   * stream a caller sees is numbered once from end to end. That is what lets a
   * reconnect say "I had up to N" and mean it.
   */
  initialSequence?: number;
  idFactory?: () => string;
  clock?: () => Date;
};

export type AgentSession = {
  readonly id: string;
  readonly messages: readonly AgentMessage[];
  run(input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(reason?: string): void;
  respondToPermission(requestId: string, decision: Exclude<PermissionDecision, 'ask'>): boolean;
  close(): Promise<void>;
};

type PermissionWaiter = {
  resolve: (decision: 'allow' | 'deny') => void;
};

type SettledExecution = { ok: true; output: ToolExecutionResult } | { ok: false; error: unknown };

const DEFAULT_LIMITS: AgentLimits = { maxTurns: 24, maxOutputTokens: 8_192 };

export function createAgentSession(config: AgentSessionConfig): AgentSession {
  return new AgentSessionImpl(config);
}

export async function resumeAgentSession(
  config: AgentSessionConfig & { sessionStore: SessionStore },
  sessionId: string,
): Promise<AgentSession> {
  const stored = await config.sessionStore.load(sessionId);
  if (!stored) {
    throw new AgentHarnessError(`Session not found: ${sessionId}`, 'SESSION_NOT_FOUND');
  }
  return new AgentSessionImpl({
    ...config,
    sessionId: stored.id,
    initialMessages: stored.messages,
    sessionCreatedAt: stored.createdAt,
    sessionState: { mode: 'persistent', resumed: true, origin: 'store' },
    metadata: stored.metadata,
  });
}

class AgentSessionImpl implements AgentSession {
  readonly id: string;
  private readonly history: AgentMessage[] = [];
  private readonly registry: ToolRegistry;
  private readonly permissions: PermissionHandler;
  private readonly limits: AgentLimits;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly workingDirectory: string;
  private readonly contextManager: ContextManager;
  private readonly hooks: HookRegistry;
  private readonly sessionStore: SessionStore | undefined;
  private readonly metadata: Record<string, unknown>;
  private readonly createdAt: string;
  private readonly commands: CommandRegistry | undefined;
  private readonly artifactStore: ArtifactStore | undefined;
  private readonly maxInlineToolResultChars: number;
  private readonly eventSink: EventSink | undefined;
  private readonly logSink: LogSink | undefined;
  private readonly logContext: LogContext;
  private readonly budget: BudgetTracker;
  private readonly rateLimiter: SessionRateLimiter | undefined;
  private readonly projectContextProvider: ProjectContextProvider | undefined;
  private readonly modelCapabilities: ModelContextCapabilities | undefined;
  private readonly pendingPermissions = new Map<string, PermissionWaiter>();
  private activeController: AbortController | undefined;
  private running = false;
  private started = false;
  private closed = false;
  private sequence = 0;

  constructor(private readonly config: AgentSessionConfig) {
    this.idFactory = config.idFactory ?? randomUUID;
    this.clock = config.clock ?? (() => new Date());
    this.id = config.sessionId ?? this.idFactory();
    this.registry =
      config.tools instanceof ToolRegistry ? config.tools : new ToolRegistry(config.tools ?? []);
    this.permissions = config.permissionHandler ?? new DefaultPermissionHandler();
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    // Built from the limits rather than left at its defaults, so a session given a
    // `compactionThresholdPercent` and no explicit manager still shrinks where the
    // record asked it to. An explicit `contextManager` is left entirely alone; a
    // caller that supplied one has already chosen its policy.
    const derivedPolicy =
      this.limits.compactionThresholdPercent === undefined
        ? undefined
        : contextPolicyFromPercent(this.limits.compactionThresholdPercent);
    this.workingDirectory = config.workingDirectory ?? process.cwd();
    // Only the policy is handed over. The reply reservation is deliberately left to
    // the context layer's own resolution, which reserves what the *model* reports
    // rather than what this session happens to cap a single response at — narrowing
    // it here would quietly widen the input budget beyond what the model can hold.
    this.contextManager =
      config.contextManager ??
      new DynamicCompactingContextManager(
        derivedPolicy === undefined ? {} : { policy: derivedPolicy },
      );
    this.hooks = config.hooks ?? new HookRegistry();
    this.sessionStore = config.sessionStore;
    this.metadata = structuredClone(config.metadata ?? {});
    this.createdAt = config.sessionCreatedAt ?? this.now();
    this.commands = config.commands;
    this.artifactStore = config.artifactStore;
    this.maxInlineToolResultChars = config.maxInlineToolResultChars ?? 100_000;
    this.eventSink = config.eventSink;
    this.logSink = config.logSink;
    this.logContext = config.logContext ?? {};
    this.budget = new BudgetTracker(config.budget);
    this.rateLimiter = config.rateLimiter;
    this.projectContextProvider = config.projectContextProvider;
    this.modelCapabilities = config.modelCapabilities;
    this.sequence = config.initialSequence ?? 0;
    this.history.push(...structuredClone(config.initialMessages ?? []));
  }

  get messages(): readonly AgentMessage[] {
    return this.history.map((message) => structuredClone(message));
  }

  async *run(input: AgentInput): AsyncIterable<AgentEvent> {
    if (this.closed) {
      throw new AgentHarnessError('Session is closed', 'SESSION_CLOSED');
    }
    if (this.running) {
      throw new AgentHarnessError('Session already has an active turn', 'SESSION_BUSY');
    }
    // Images alone are a valid turn; a caller that sends them without words still
    // gets a prompt, composed by `prepareAttachments`.
    if (!input.prompt.trim() && !input.images?.length) {
      throw new AgentHarnessError('Prompt cannot be empty', 'EMPTY_PROMPT');
    }
    if (this.rateLimiter && !this.rateLimiter.acquire()) {
      throw new AgentHarnessError('Session rate limit exceeded', 'RATE_LIMITED', true);
    }

    this.running = true;
    this.activeController = new AbortController();

    try {
      if (!this.started) {
        this.started = true;
        yield this.event({
          type: 'session.started',
          ...(this.config.sessionState ?? {
            mode: this.sessionStore ? ('persistent' as const) : ('stateless' as const),
            storage: this.sessionStore?.kind ?? 'none',
            resumed: false,
            origin: this.sessionStore ? ('new' as const) : ('stateless' as const),
          }),
          historyMessageCount: this.history.length,
        });
      }

      const resolvedInput = await this.commands?.resolve(input.prompt);
      const prompt =
        resolvedInput?.type === 'local'
          ? `Local command output:\n${resolvedInput.output}`
          : resolvedInput?.type === 'prompt'
            ? resolvedInput.prompt
            : input.prompt;
      this.history.push(userMessage(this.idFactory(), prompt, this.now(), input.images ?? []));
      await this.persist();

      let reactiveCompactionAttempts = 0;
      // Starts unset: the only input ceiling a run has is the one the context layer
      // derives from the model. This is filled in only by the reactive retry below,
      // after the provider has rejected a context the estimate thought would fit.
      let reactiveMaxInputTokens: number | undefined;
      // Spent on the first turn that asks for it, so a requested compaction happens
      // once rather than on every turn of the run.
      let pendingForcedCompaction = this.config.compactContext === true;
      for (let turn = 1; turn <= this.limits.maxTurns; turn += 1) {
        this.throwIfAborted();
        const turnId = this.idFactory();
        yield this.event({ type: 'turn.started', turnId, turn });

        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        const toolCalls: ToolCallBlock[] = [];
        let stopReason: StopReason = 'end_turn';
        let modelStarted: number | undefined;
        let modelRequestId: string | undefined;

        try {
          const forceCompaction = pendingForcedCompaction;
          pendingForcedCompaction = false;
          const prepared = await this.contextManager.prepare({
            messages: this.messages,
            ...(reactiveMaxInputTokens === undefined
              ? {}
              : { maxInputTokens: reactiveMaxInputTokens }),
            ...(this.modelCapabilities === undefined
              ? {}
              : { modelCapabilities: this.modelCapabilities }),
            ...(forceCompaction ? { forceCompaction: true } : {}),
          });
          if (prepared.compacted) {
            yield this.event({
              type: 'context.compaction.started',
              turnId,
              estimatedTokens: prepared.tokensBefore ?? prepared.estimatedTokens,
            });
            yield this.event({
              type: 'context.compaction.completed',
              turnId,
              tokensBefore: prepared.tokensBefore ?? prepared.estimatedTokens,
              tokensAfter: prepared.estimatedTokens,
            });
          } else if (forceCompaction && prepared.metadata?.skipped) {
            // A requested compaction that found nothing to do. Reported, because a
            // client that offered the action has to be able to tell the user why
            // nothing changed — silence there is indistinguishable from a lost
            // request or a broken button.
            yield this.event({
              type: 'warning',
              code: 'CONTEXT_COMPACTION_SKIPPED',
              message:
                prepared.metadata.skipped === 'already-minimal'
                  ? 'The context is already as small as summarising it would make it, so it was left alone.'
                  : 'There are no earlier turns outside the retained window to summarise.',
            });
          }
          // Warned at the point the policy itself names, so the threshold an agent
          // configured is the threshold a reader hears about. Only the two tiers
          // below compaction warn: at `critical` the compaction events above have
          // already said everything a warning would.
          if (
            prepared.metadata?.pressure === 'warning' ||
            prepared.metadata?.pressure === 'aggressive'
          ) {
            const percent = prepared.budget
              ? Math.round(prepared.budget.utilizationFraction * 1_000) / 10
              : undefined;
            yield this.event({
              type: 'warning',
              code: 'CONTEXT_PRESSURE',
              message:
                `The context is ${percent === undefined ? 'approaching' : `at ${percent}% of`} its input budget` +
                (prepared.metadata.toolResultsTruncated
                  ? `; ${prepared.metadata.toolResultsTruncated} oversized tool result(s) were shortened to fit.`
                  : '; earlier turns will be summarised if it keeps growing.'),
            });
          }
          // Every turn, compacted or not: a usage meter needs the number that did
          // not trigger compaction as much as the one that did. The budget comes
          // from the context layer when it reported one, and falls back to the
          // session's own ceiling so the event is still meaningful with a
          // passthrough or custom context manager.
          const contextBudget = prepared.budget?.effectiveInputBudget ?? reactiveMaxInputTokens;
          if (contextBudget !== undefined && contextBudget > 0) {
            yield this.event({
              type: 'context.usage',
              turnId,
              usedTokens: prepared.estimatedTokens,
              budgetTokens: contextBudget,
              ...(prepared.budget?.contextWindow === undefined
                ? this.modelCapabilities === undefined
                  ? {}
                  : { contextWindow: this.modelCapabilities.contextWindow }
                : { contextWindow: prepared.budget.contextWindow }),
              ...(prepared.budget?.outputReserved === undefined
                ? {}
                : { reservedOutputTokens: prepared.budget.outputReserved }),
              usedPercent: Math.round((prepared.estimatedTokens / contextBudget) * 1_000) / 10,
              compacted: prepared.compacted,
              // The reading before the layer acted, carried alongside the one after
              // so a meter can show both the peak and the relief rather than only
              // the number that survived.
              ...(prepared.tokensBefore === undefined
                ? {}
                : {
                    peakTokens: prepared.tokensBefore,
                    peakPercent: Math.round((prepared.tokensBefore / contextBudget) * 1_000) / 10,
                  }),
              ...(prepared.metadata?.pressure === undefined
                ? {}
                : { pressure: prepared.metadata.pressure }),
              ...(prepared.metadata?.toolResultsTruncated === undefined
                ? {}
                : { toolResultsTruncated: prepared.metadata.toolResultsTruncated }),
            });
          }
          const projectContext = await this.projectContextProvider?.collect(
            this.activeController.signal,
          );
          const systemPrompt = [
            this.config.systemPrompt,
            projectContext === undefined ? undefined : formatProjectContext(projectContext),
          ]
            .filter((part): part is string => Boolean(part))
            .join('\n\n');
          modelRequestId = randomUUID();
          const modelRequest = {
            messages: prepared.messages,
            tools: this.registry.descriptors(),
            signal: this.activeController.signal,
            modelRequestId,
            sessionId: this.id,
            turnId,
            ...(this.config.model === undefined ? {} : { model: this.config.model }),
            ...(systemPrompt === '' ? {} : { systemPrompt }),
            ...(this.limits.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: this.limits.maxOutputTokens }),
          };
          for (const hook of this.hooks.list()) {
            await hook.beforeModel?.({ sessionId: this.id, turnId }, modelRequest);
          }
          modelStarted = Date.now();
          this.log({
            event: 'model.request.started',
            sessionId: this.id,
            turnId,
            modelRequestId,
            turn,
            provider: this.config.provider.name,
            model: this.config.model,
            messageCount: modelRequest.messages.length,
            toolCount: modelRequest.tools.length,
            estimatedInputTokens: prepared.estimatedTokens,
            systemPromptChars: modelRequest.systemPrompt?.length ?? 0,
            maxOutputTokens: modelRequest.maxOutputTokens,
          });
          this.log({
            level: 'debug',
            event: 'model.request.details',
            sessionId: this.id,
            turnId,
            modelRequestId,
            turn,
            provider: this.config.provider.name,
            model: this.config.model,
            request: {
              messages: modelRequest.messages,
              tools: modelRequest.tools,
              ...(modelRequest.model === undefined ? {} : { model: modelRequest.model }),
              ...(modelRequest.systemPrompt === undefined
                ? {}
                : { systemPrompt: modelRequest.systemPrompt }),
              ...(modelRequest.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: modelRequest.maxOutputTokens }),
            },
          });
          for await (const modelEvent of this.config.provider.stream(modelRequest)) {
            this.throwIfAborted();
            switch (modelEvent.type) {
              case 'text_delta':
                textParts.push(modelEvent.delta);
                yield this.event({
                  type: 'assistant.text.delta',
                  turnId,
                  delta: modelEvent.delta,
                });
                break;
              case 'reasoning_delta':
                reasoningParts.push(modelEvent.delta);
                yield this.event({
                  type: 'assistant.reasoning.delta',
                  turnId,
                  delta: modelEvent.delta,
                });
                break;
              case 'tool_call_delta':
                yield this.event({
                  type: 'tool.input.delta',
                  turnId,
                  index: modelEvent.index,
                  toolCallId: modelEvent.id,
                  toolName: modelEvent.name,
                  delta: modelEvent.argumentsDelta,
                });
                break;
              case 'warning':
                yield this.event({
                  type: 'warning',
                  code: modelEvent.code,
                  message: modelEvent.message,
                });
                break;
              case 'tool_call': {
                const call: ToolCallBlock = {
                  type: 'tool_call',
                  id: modelEvent.id,
                  name: modelEvent.name,
                  input: modelEvent.input,
                };
                toolCalls.push(call);
                yield this.event({ type: 'tool.requested', turnId, call });
                break;
              }
              case 'usage':
                yield this.event({ type: 'usage.updated', turnId, usage: modelEvent.usage });
                {
                  const budget = this.budget.add(modelEvent.usage);
                  if (budget.exceeded) {
                    throw new AgentHarnessError(
                      budget.reason ?? 'Budget exceeded',
                      'BUDGET_EXCEEDED',
                    );
                  }
                }
                break;
              case 'completed':
                stopReason = modelEvent.stopReason;
                break;
            }
          }
          this.log({
            event: 'model.request.completed',
            sessionId: this.id,
            turnId,
            modelRequestId,
            turn,
            provider: this.config.provider.name,
            model: this.config.model,
            stopReason,
            outputChars: textParts.join('').length,
            reasoningChars: reasoningParts.join('').length,
            toolCallCount: toolCalls.length,
            toolNames: toolCalls.map((call) => call.name),
            durationMs: Date.now() - modelStarted,
          });
          this.log({
            level: 'debug',
            event: 'model.response.details',
            sessionId: this.id,
            turnId,
            modelRequestId,
            turn,
            provider: this.config.provider.name,
            model: this.config.model,
            stopReason,
            text: textParts.join(''),
            ...(reasoningParts.length === 0 ? {} : { reasoning: reasoningParts.join('') }),
            toolCalls,
          });
        } catch (error) {
          this.log({
            level:
              this.activeController.signal.aborted ||
              error instanceof AgentAbortError ||
              isPromptTooLong(error)
                ? 'warn'
                : 'error',
            event: 'model.request.failed',
            sessionId: this.id,
            turnId,
            ...(modelRequestId === undefined ? {} : { modelRequestId }),
            turn,
            provider: this.config.provider.name,
            model: this.config.model,
            ...(modelStarted === undefined ? {} : { durationMs: Date.now() - modelStarted }),
            error: describeError(error),
          });
          if (this.activeController.signal.aborted || error instanceof AgentAbortError) {
            yield this.event({
              type: 'turn.completed',
              turnId,
              turn,
              reason: 'cancelled',
            });
            yield this.event({
              type: 'session.completed',
              reason: 'cancelled',
              historyMessageCount: this.history.length,
            });
            return;
          }
          if (isPromptTooLong(error) && reactiveCompactionAttempts < 1) {
            reactiveCompactionAttempts += 1;
            reactiveMaxInputTokens = Math.max(
              1_000,
              Math.floor(estimateMessagesTokens(this.messages) / 2),
            );
            yield this.event({
              type: 'warning',
              code: 'REACTIVE_COMPACTION',
              message: 'Model rejected the context; compacting and retrying once',
            });
            turn -= 1;
            continue;
          }
          yield this.event({
            type: 'error',
            code: error instanceof AgentHarnessError ? error.code : 'MODEL_ERROR',
            message: errorMessage(error),
            recoverable: false,
          });
          yield this.event({
            type: 'session.completed',
            reason:
              error instanceof AgentHarnessError && error.code === 'BUDGET_EXCEEDED'
                ? 'budget_exceeded'
                : 'model_error',
            historyMessageCount: this.history.length,
          });
          return;
        }

        const assistantMessage: AgentMessage = {
          id: this.idFactory(),
          role: 'assistant',
          createdAt: this.now(),
          ...(reasoningParts.length === 0 ? {} : { reasoning: reasoningParts.join('') }),
          content: [
            ...(textParts.length === 0
              ? []
              : [{ type: 'text' as const, text: textParts.join('') }]),
            ...toolCalls,
          ],
        };
        this.history.push(assistantMessage);
        await this.persist();
        for (const hook of this.hooks.list()) {
          await hook.afterModel?.({ sessionId: this.id, turnId }, assistantMessage, stopReason);
        }
        yield this.event({
          type: 'assistant.message.completed',
          turnId,
          message: structuredClone(assistantMessage),
        });

        if (toolCalls.length === 0) {
          let continuation: string | undefined;
          for (const hook of this.hooks.list()) {
            const result = await hook.onStop?.({ sessionId: this.id, turnId }, this.messages);
            if (result?.continueWithPrompt) continuation = result.continueWithPrompt;
          }
          if (continuation) {
            this.history.push(textMessage(this.idFactory(), 'user', continuation, this.now()));
            await this.persist();
            yield this.event({
              type: 'turn.completed',
              turnId,
              turn,
              reason: 'end_turn',
            });
            continue;
          }
          this.log({
            event: 'output.completed',
            sessionId: this.id,
            turnId,
            turn,
            messageId: assistantMessage.id,
            stopReason,
            outputChars: textParts.join('').length,
            reasoningChars: reasoningParts.join('').length,
            usage: this.budget.snapshot(),
          });
          yield this.event({ type: 'turn.completed', turnId, turn, reason: stopReason });
          yield this.event({
            type: 'session.completed',
            reason: stopReason,
            historyMessageCount: this.history.length,
          });
          return;
        }

        const results: ToolResultBlock[] = [];
        for (let index = 0; index < toolCalls.length;) {
          this.throwIfAborted();
          const call = toolCalls[index];
          if (!call) break;
          const tool = this.registry.get(call.name);
          if (!tool?.concurrencySafe) {
            const resultGenerator = this.executeTool(call, turnId);
            let result: ToolResultBlock | undefined;
            while (true) {
              const next = await resultGenerator.next();
              if (next.done) {
                result = next.value;
                break;
              }
              yield next.value;
            }
            results.push(result);
            index += 1;
            continue;
          }

          const batch: ToolCallBlock[] = [];
          while (index < toolCalls.length) {
            const candidate = toolCalls[index];
            if (!candidate || !this.registry.get(candidate.name)?.concurrencySafe) break;
            batch.push(candidate);
            index += 1;
          }
          const batchGenerator = this.executeConcurrentToolBatch(batch, turnId);
          while (true) {
            const next = await batchGenerator.next();
            if (next.done) {
              results.push(...next.value);
              break;
            }
            yield next.value;
          }
        }

        this.history.push({
          id: this.idFactory(),
          role: 'user',
          createdAt: this.now(),
          content: results,
        });
        await this.persist();
        yield this.event({ type: 'turn.completed', turnId, turn, reason: 'tool_use' });
      }

      yield this.event({
        type: 'warning',
        code: 'MAX_TURNS_REACHED',
        message: `Maximum turn count (${this.limits.maxTurns}) reached`,
      });
      yield this.event({
        type: 'session.completed',
        reason: 'max_turns',
        historyMessageCount: this.history.length,
      });
    } finally {
      this.running = false;
      this.activeController = undefined;
    }
  }

  interrupt(reason = 'interrupted'): void {
    this.activeController?.abort(reason);
    for (const waiter of this.pendingPermissions.values()) waiter.resolve('deny');
    this.pendingPermissions.clear();
  }

  respondToPermission(requestId: string, decision: 'allow' | 'deny'): boolean {
    const waiter = this.pendingPermissions.get(requestId);
    if (!waiter) return false;
    this.pendingPermissions.delete(requestId);
    waiter.resolve(decision);
    return true;
  }

  async close(): Promise<void> {
    this.interrupt('closed');
    this.closed = true;
  }

  private async *executeTool(
    call: ToolCallBlock,
    turnId: string,
  ): AsyncGenerator<AgentEvent, ToolResultBlock> {
    const lifecycleStarted = Date.now();
    const tool = this.registry.get(call.name);
    if (!tool) {
      const result = this.toolError(call.id, `Unknown tool: ${call.name}`);
      this.logToolTerminal(call, turnId, result, lifecycleStarted, {
        event: 'tool.execution.failed',
        failureStage: 'resolution',
        code: 'UNKNOWN_TOOL',
      });
      yield this.event({ type: 'tool.completed', turnId, result });
      return result;
    }

    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      const result = this.toolError(
        call.id,
        `Invalid input for ${call.name}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
          .join('; ')}`,
      );
      this.logToolTerminal(call, turnId, result, lifecycleStarted, {
        event: 'tool.execution.failed',
        failureStage: 'validation',
        code: 'INVALID_TOOL_INPUT',
        tool,
        issueCount: parsed.error.issues.length,
      });
      yield this.event({ type: 'tool.completed', turnId, result });
      return result;
    }

    for (const hook of this.hooks.list()) {
      const hookResult = await hook.beforeTool?.({ sessionId: this.id, turnId }, call);
      if (hookResult && !hookResult.allow) {
        const result = this.toolError(
          call.id,
          hookResult.message ?? `Blocked by hook ${hook.name}`,
        );
        this.logToolTerminal(call, turnId, result, lifecycleStarted, {
          event: 'tool.execution.denied',
          failureStage: 'hook',
          code: 'TOOL_BLOCKED_BY_HOOK',
          tool,
          deniedBy: hook.name,
        });
        yield this.event({ type: 'tool.completed', turnId, result });
        return result;
      }
    }

    // Per-invocation check owned by the tool. A `deny` here is absolute: no
    // rule, mode, or handler can override it, because the tool is the only
    // component that understands its own input.
    let toolCheck: ToolPermissionCheck | undefined;
    if (tool.checkPermissions) {
      try {
        toolCheck = await tool.checkPermissions(parsed.data, {
          sessionId: this.id,
          workingDirectory: this.workingDirectory,
        });
      } catch (error) {
        const result = this.toolError(
          call.id,
          `Permission check failed for ${tool.name}: ${errorMessage(error)}`,
        );
        this.logToolTerminal(call, turnId, result, lifecycleStarted, {
          event: 'tool.execution.failed',
          failureStage: 'permission_check',
          code: 'TOOL_PERMISSION_CHECK_FAILED',
          tool,
          error,
        });
        yield this.event({ type: 'tool.completed', turnId, result });
        return result;
      }
      if (toolCheck.decision === 'deny') {
        const result = this.toolError(
          call.id,
          toolCheck.reason ?? `Permission denied for ${tool.name}`,
        );
        this.logToolTerminal(call, turnId, result, lifecycleStarted, {
          event: 'tool.execution.denied',
          failureStage: 'tool_permission',
          code: 'TOOL_PERMISSION_DENIED',
          tool,
        });
        yield this.event({ type: 'tool.completed', turnId, result });
        for (const hook of this.hooks.list()) {
          await hook.afterTool?.({ sessionId: this.id, turnId }, call, result);
        }
        return result;
      }
    }

    let decision = await this.permissions.evaluate({
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      tool,
      input: parsed.data,
      workingDirectory: this.workingDirectory,
      ...(toolCheck === undefined ? {} : { toolCheck }),
    });

    if (decision === 'ask') {
      const requestId = this.idFactory();
      const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
        this.pendingPermissions.set(requestId, { resolve });
      });
      yield this.event({
        type: 'permission.requested',
        turnId,
        requestId,
        toolCallId: call.id,
        toolName: tool.name,
        input: structuredClone(parsed.data),
        description: describePermissionRequest(tool, toolCheck),
      });
      decision = await decisionPromise;
      yield this.event({
        type: 'permission.resolved',
        turnId,
        requestId,
        decision,
      });
    }

    if (decision === 'deny') {
      const result = this.toolError(
        call.id,
        toolCheck?.reason === undefined
          ? `Permission denied for ${tool.name}`
          : `Permission denied for ${tool.name}: ${toolCheck.reason}`,
      );
      this.logToolTerminal(call, turnId, result, lifecycleStarted, {
        event: 'tool.execution.denied',
        failureStage: 'permission_policy',
        code: 'TOOL_PERMISSION_DENIED',
        tool,
      });
      yield this.event({ type: 'tool.completed', turnId, result });
      for (const hook of this.hooks.list()) {
        await hook.afterTool?.({ sessionId: this.id, turnId }, call, result);
      }
      return result;
    }

    const toolStarted = Date.now();
    this.log({
      event: 'tool.execution.started',
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      toolName: tool.name,
      toolKind: tool.kind,
      inputSummary: summarizeValue(parsed.data),
    });
    this.log({
      level: 'debug',
      event: 'tool.execution.input',
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      toolName: tool.name,
      toolKind: tool.kind,
      input: parsed.data,
    });
    yield this.event({ type: 'tool.started', turnId, call });
    const progress = new AsyncEventQueue<AgentEvent>();
    const context: ToolExecutionContext = {
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      workingDirectory: this.workingDirectory,
      signal: this.activeController?.signal ?? AbortSignal.abort(),
      messages: this.messages,
      reportProgress: (message, data) => {
        progress.push(
          this.event({
            type: 'tool.progress',
            turnId,
            toolCallId: call.id,
            message,
            ...(data === undefined ? {} : { data }),
          }),
        );
      },
    };

    try {
      // Settled into a value rather than awaited directly, so the rejection is
      // handled the moment it happens and the queue below can be drained for as
      // long as the tool runs without leaving a rejected promise unattended.
      const execution: Promise<SettledExecution> = tool.execute(parsed.data, context).then(
        (output) => ({ ok: true as const, output }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      void execution.then(() => progress.close());
      // The progress a long command reports as it goes, forwarded as it goes.
      yield* progress.drain();
      const settled = await execution;
      if (!settled.ok) throw settled.error;
      const output = settled.output;
      let content = output.content;
      let artifactMetadata: Record<string, unknown> = {};
      if (content.length > this.maxInlineToolResultChars && this.artifactStore) {
        const artifact = await this.artifactStore.put(content, {
          contentType: 'text/plain',
          metadata: {
            sessionId: this.id,
            turnId,
            toolCallId: call.id,
            toolName: call.name,
          },
        });
        const previewSize = Math.max(500, Math.floor(this.maxInlineToolResultChars / 2));
        content = `${content.slice(0, previewSize)}\n\n[...stored as artifact ${artifact.id}...]\n\n${content.slice(-previewSize)}`;
        artifactMetadata = { artifact };
      }
      const result: ToolResultBlock = {
        type: 'tool_result',
        toolCallId: call.id,
        content,
        isError: output.isError ?? false,
        ...(output.metadata === undefined && Object.keys(artifactMetadata).length === 0
          ? {}
          : { metadata: { ...output.metadata, ...artifactMetadata } }),
      };
      this.log({
        ...(result.isError ? { level: 'error' as const } : {}),
        event: 'tool.execution.completed',
        sessionId: this.id,
        turnId,
        toolCallId: call.id,
        toolName: tool.name,
        toolKind: tool.kind,
        outcome: result.isError ? 'failure' : 'success',
        isError: result.isError,
        resultChars: result.content.length,
        metadataKeys: safeObjectKeys(result.metadata ?? {}),
        ...(result.isError ? { errorMessage: truncateLogText(result.content) } : {}),
        durationMs: Date.now() - toolStarted,
      });
      this.log({
        level: 'debug',
        event: 'tool.execution.output',
        sessionId: this.id,
        turnId,
        toolCallId: call.id,
        toolName: tool.name,
        toolKind: tool.kind,
        input: parsed.data,
        result,
        durationMs: Date.now() - toolStarted,
      });
      yield this.event({ type: 'tool.completed', turnId, result });
      const presentedArtifact = responseArtifact(result.metadata?.artifact);
      if (presentedArtifact) {
        yield this.event({
          type: 'artifact.created',
          turnId,
          toolCallId: call.id,
          artifact: presentedArtifact,
        });
      }
      return result;
    } catch (error) {
      // Whatever the tool reported before it failed has already been yielded.
      const result = this.toolError(call.id, errorMessage(error));
      this.log({
        level: 'error',
        event: 'tool.execution.failed',
        sessionId: this.id,
        turnId,
        toolCallId: call.id,
        toolName: tool.name,
        toolKind: tool.kind,
        failureStage: 'execution',
        code: 'TOOL_EXECUTION_FAILED',
        outcome: 'failure',
        resultChars: result.content.length,
        durationMs: Date.now() - toolStarted,
        error: describeError(error),
      });
      this.log({
        level: 'debug',
        event: 'tool.execution.failure_details',
        sessionId: this.id,
        turnId,
        toolCallId: call.id,
        toolName: tool.name,
        toolKind: tool.kind,
        input: parsed.data,
        result,
        error: describeError(error),
      });
      yield this.event({ type: 'tool.completed', turnId, result });
      for (const hook of this.hooks.list()) {
        await hook.afterTool?.({ sessionId: this.id, turnId }, call, result);
      }
      return result;
    }
  }

  private async *executeConcurrentToolBatch(
    calls: readonly ToolCallBlock[],
    turnId: string,
  ): AsyncGenerator<AgentEvent, ToolResultBlock[]> {
    type State = {
      index: number;
      generator: AsyncGenerator<AgentEvent, ToolResultBlock>;
      next: Promise<IteratorResult<AgentEvent, ToolResultBlock>>;
    };
    const states: State[] = calls.map((call, index) => {
      const generator = this.executeTool(call, turnId);
      return { index, generator, next: generator.next() };
    });
    const results: ToolResultBlock[] = new Array(calls.length);

    while (states.length > 0) {
      const raced = await Promise.race(
        states.map(async (state) => ({ state, iteration: await state.next })),
      );
      if (raced.iteration.done) {
        results[raced.state.index] = raced.iteration.value;
        states.splice(states.indexOf(raced.state), 1);
      } else {
        raced.state.next = raced.state.generator.next();
        yield raced.iteration.value;
      }
    }
    return results;
  }

  private toolError(toolCallId: string, content: string): ToolResultBlock {
    return { type: 'tool_result', toolCallId, content, isError: true };
  }

  private logToolTerminal(
    call: ToolCallBlock,
    turnId: string,
    result: ToolResultBlock,
    started: number,
    details: {
      event: 'tool.execution.failed' | 'tool.execution.denied';
      failureStage: string;
      code: string;
      tool?: Tool;
      error?: unknown;
      [key: string]: unknown;
    },
  ): void {
    const { event, tool, error, ...fields } = details;
    this.log({
      level: event === 'tool.execution.denied' ? 'warn' : 'error',
      event,
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      toolName: call.name,
      ...(tool === undefined ? {} : { toolKind: tool.kind }),
      outcome: event === 'tool.execution.denied' ? 'denied' : 'failure',
      resultChars: result.content.length,
      errorMessage: truncateLogText(result.content),
      durationMs: Date.now() - started,
      ...fields,
      ...(error === undefined ? {} : { error: describeError(error) }),
    });
    this.log({
      level: 'debug',
      event: 'tool.execution.rejection_details',
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      toolName: call.name,
      call,
      result,
      ...fields,
      ...(error === undefined ? {} : { error: describeError(error) }),
    });
  }

  private event(payload: EventPayload): AgentEvent {
    const event = {
      ...payload,
      protocolVersion: 1,
      sequence: ++this.sequence,
      timestamp: this.now(),
      sessionId: this.id,
    } as AgentEvent;
    try {
      this.eventSink?.onEvent(event);
    } catch {
      // Observability is never an execution dependency.
    }
    this.log({
      level: agentEventLogLevel(event),
      event: event.type,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      eventSequence: event.sequence,
      ...eventCorrelation(event),
      ...agentEventLogFields(event),
    });
    return event;
  }

  private log(entry: Parameters<LogSink['log']>[0]): void {
    emitLog(this.logSink, { ...this.logContext, ...entry });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private throwIfAborted(): void {
    if (this.activeController?.signal.aborted) throw new AgentAbortError();
  }

  private async persist(): Promise<void> {
    if (!this.sessionStore) return;
    const started = Date.now();
    const stored: StoredSession = {
      version: 1,
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      messages: structuredClone(this.history),
      metadata: structuredClone(this.metadata),
    };
    try {
      await this.sessionStore.save(stored);
      this.log({
        level: 'debug',
        event: 'session.persistence.completed',
        sessionId: this.id,
        storage: this.sessionStore.kind ?? 'custom',
        messageCount: stored.messages.length,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      this.log({
        level: 'error',
        event: 'session.persistence.failed',
        sessionId: this.id,
        storage: this.sessionStore.kind ?? 'custom',
        messageCount: stored.messages.length,
        durationMs: Date.now() - started,
        error: describeError(error),
      });
      throw error;
    }
  }
}

function responseArtifact(value: unknown): Artifact | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const artifact = value as Partial<Artifact>;
  if (
    typeof artifact.id !== 'string' ||
    typeof artifact.contentType !== 'string' ||
    typeof artifact.size !== 'number' ||
    typeof artifact.createdAt !== 'string' ||
    artifact.metadata === null ||
    typeof artifact.metadata !== 'object' ||
    artifact.metadata.presentation !== 'file'
  ) {
    return undefined;
  }
  return artifact as Artifact;
}

function agentEventLogLevel(event: AgentEvent): 'debug' | 'info' | 'warn' | 'error' {
  if (event.type === 'error') return 'error';
  if (event.type === 'warning') return 'warn';
  if (
    event.type === 'assistant.text.delta' ||
    event.type === 'assistant.reasoning.delta' ||
    event.type === 'assistant.message.completed' ||
    event.type === 'tool.input.delta' ||
    event.type === 'tool.requested' ||
    event.type === 'tool.started' ||
    event.type === 'tool.completed' ||
    event.type === 'tool.progress' ||
    event.type === 'usage.updated'
  ) {
    return 'debug';
  }
  return 'info';
}

function agentEventLogFields(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'session.started':
      return {
        mode: event.mode,
        storage: event.storage,
        resumed: event.resumed,
        origin: event.origin,
        historyMessageCount: event.historyMessageCount,
      };
    case 'session.completed':
      return { reason: event.reason, historyMessageCount: event.historyMessageCount };
    case 'turn.started':
      return { turn: event.turn };
    case 'turn.completed':
      return { turn: event.turn, reason: event.reason };
    case 'tool.requested':
      return {
        toolName: event.call.name,
        inputSummary: summarizeValue(event.call.input),
      };
    case 'tool.started':
      return {
        toolName: event.call.name,
        inputSummary: summarizeValue(event.call.input),
      };
    case 'tool.completed':
      return {
        isError: event.result.isError,
        resultChars: event.result.content.length,
      };
    case 'permission.requested':
      return {
        requestId: event.requestId,
        toolName: event.toolName,
        description: event.description,
        inputSummary: summarizeValue(event.input),
      };
    case 'permission.resolved':
      return { requestId: event.requestId, decision: event.decision };
    case 'context.compaction.started':
      return { estimatedTokens: event.estimatedTokens };
    case 'context.compaction.completed':
      return { tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter };
    case 'context.usage':
      return {
        usedTokens: event.usedTokens,
        budgetTokens: event.budgetTokens,
        usedPercent: event.usedPercent,
        compacted: event.compacted,
        ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
      };
    case 'run.preparing':
      return {
        stage: event.stage,
        message: event.message,
        ...(event.data === undefined ? {} : { preparation: event.data }),
      };
    case 'warning':
      return { code: event.code, message: event.message };
    case 'error':
      return { code: event.code, message: event.message, recoverable: event.recoverable };
    default:
      // Raw protocol content is useful when reproducing a run but too noisy for the
      // default INFO stream. These event types are classified as DEBUG above.
      return { data: event };
  }
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  let bytes: number | undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) bytes = Buffer.byteLength(serialized, 'utf8');
  } catch {
    // A summary must never make an otherwise executable tool input fail.
  }
  return {
    type,
    ...(bytes === undefined ? {} : { bytes }),
    ...(Array.isArray(value) ? { items: value.length } : {}),
    ...(value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { keys: safeObjectKeys(value) }
      : {}),
  };
}

function safeObjectKeys(value: object): string[] {
  try {
    return Object.keys(value).sort();
  } catch {
    return [];
  }
}

function truncateLogText(value: string, maximum = 1_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…[truncated]`;
}

/**
 * Builds the human-facing text for a permission prompt. The tool's own reason is
 * more specific than its `kind`, and a destructive-command warning rides along
 * without changing the decision.
 */
function describePermissionRequest(tool: Tool, toolCheck: ToolPermissionCheck | undefined): string {
  const base =
    toolCheck?.reason === undefined
      ? `${tool.kind} operation requested by ${tool.name}`
      : `${tool.name}: ${toolCheck.reason}`;
  return toolCheck?.warning === undefined ? base : `${base}\n${toolCheck.warning}`;
}

function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return (
    status === 413 ||
    /prompt.{0,20}(too long|context|large)|context.{0,20}(window|length|limit)/i.test(error.message)
  );
}

function eventCorrelation(event: AgentEvent): Record<string, unknown> {
  const turnId = 'turnId' in event ? event.turnId : undefined;
  const toolCallId =
    event.type === 'tool.requested' || event.type === 'tool.started'
      ? event.call.id
      : event.type === 'tool.completed'
        ? event.result.toolCallId
        : event.type === 'artifact.created'
          ? event.toolCallId
          : event.type === 'tool.progress' || event.type === 'permission.requested'
            ? event.toolCallId
            : undefined;
  return {
    ...(turnId === undefined ? {} : { turnId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

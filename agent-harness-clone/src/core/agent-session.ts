import { randomUUID } from 'node:crypto';
import { AgentAbortError, AgentHarnessError, errorMessage } from './errors.js';
import type { AgentEvent, EventPayload } from './events.js';
import type { AgentInput, AgentMessage, ToolCallBlock, ToolResultBlock } from './messages.js';
import { textMessage } from './messages.js';
import {
  CompactingContextManager,
  estimateMessagesTokens,
  type ContextManager,
} from '../context/context-manager.js';
import { HookRegistry } from '../hooks/hooks.js';
import type { ModelProvider, StopReason } from '../models/provider.js';
import {
  DefaultPermissionHandler,
  type PermissionDecision,
  type PermissionHandler,
} from '../permissions/permission-handler.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolExecutionContext } from '../tools/tool.js';
import type { SessionStore, StoredSession } from '../sessions/session-store.js';
import type { CommandRegistry } from '../commands/commands.js';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import type { EventSink } from '../services/observability.js';
import { BudgetTracker, type BudgetLimits, type SessionRateLimiter } from '../services/limits.js';
import { formatProjectContext, type ProjectContextProvider } from '../context/project-context.js';

export type AgentLimits = {
  maxTurns: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
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
  metadata?: Record<string, unknown>;
  commands?: CommandRegistry;
  artifactStore?: ArtifactStore;
  maxInlineToolResultChars?: number;
  eventSink?: EventSink;
  budget?: BudgetLimits;
  rateLimiter?: SessionRateLimiter;
  projectContextProvider?: ProjectContextProvider;
  limits?: Partial<AgentLimits>;
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
  private readonly budget: BudgetTracker;
  private readonly rateLimiter: SessionRateLimiter | undefined;
  private readonly projectContextProvider: ProjectContextProvider | undefined;
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
    this.workingDirectory = config.workingDirectory ?? process.cwd();
    this.contextManager = config.contextManager ?? new CompactingContextManager();
    this.hooks = config.hooks ?? new HookRegistry();
    this.sessionStore = config.sessionStore;
    this.metadata = structuredClone(config.metadata ?? {});
    this.createdAt = this.now();
    this.commands = config.commands;
    this.artifactStore = config.artifactStore;
    this.maxInlineToolResultChars = config.maxInlineToolResultChars ?? 100_000;
    this.eventSink = config.eventSink;
    this.budget = new BudgetTracker(config.budget);
    this.rateLimiter = config.rateLimiter;
    this.projectContextProvider = config.projectContextProvider;
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
    if (!input.prompt.trim()) {
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
        yield this.event({ type: 'session.started' });
      }

      const resolvedInput = await this.commands?.resolve(input.prompt);
      const prompt =
        resolvedInput?.type === 'local'
          ? `Local command output:\n${resolvedInput.output}`
          : resolvedInput?.type === 'prompt'
            ? resolvedInput.prompt
            : input.prompt;
      this.history.push(textMessage(this.idFactory(), 'user', prompt, this.now()));
      await this.persist();

      let reactiveCompactionAttempts = 0;
      let reactiveMaxInputTokens = this.limits.maxInputTokens;
      for (let turn = 1; turn <= this.limits.maxTurns; turn += 1) {
        this.throwIfAborted();
        const turnId = this.idFactory();
        yield this.event({ type: 'turn.started', turnId, turn });

        const textParts: string[] = [];
        const toolCalls: ToolCallBlock[] = [];
        let stopReason: StopReason = 'end_turn';

        try {
          const prepared = await this.contextManager.prepare({
            messages: this.messages,
            ...(reactiveMaxInputTokens === undefined
              ? {}
              : { maxInputTokens: reactiveMaxInputTokens }),
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
          const modelRequest = {
            messages: prepared.messages,
            tools: this.registry.descriptors(),
            signal: this.activeController.signal,
            ...(this.config.model === undefined ? {} : { model: this.config.model }),
            ...(systemPrompt === '' ? {} : { systemPrompt }),
            ...(this.limits.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: this.limits.maxOutputTokens }),
          };
          for (const hook of this.hooks.list()) {
            await hook.beforeModel?.({ sessionId: this.id, turnId }, modelRequest);
          }
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
        } catch (error) {
          if (this.activeController.signal.aborted || error instanceof AgentAbortError) {
            yield this.event({
              type: 'turn.completed',
              turnId,
              turn,
              reason: 'cancelled',
            });
            yield this.event({ type: 'session.completed', reason: 'cancelled' });
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
          });
          return;
        }

        const assistantMessage: AgentMessage = {
          id: this.idFactory(),
          role: 'assistant',
          createdAt: this.now(),
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
          yield this.event({ type: 'turn.completed', turnId, turn, reason: stopReason });
          yield this.event({ type: 'session.completed', reason: stopReason });
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
      yield this.event({ type: 'session.completed', reason: 'max_turns' });
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
    const tool = this.registry.get(call.name);
    if (!tool) {
      const result = this.toolError(call.id, `Unknown tool: ${call.name}`);
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
        yield this.event({ type: 'tool.completed', turnId, result });
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
        description: `${tool.kind} operation requested by ${tool.name}`,
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
      const result = this.toolError(call.id, `Permission denied for ${tool.name}`);
      yield this.event({ type: 'tool.completed', turnId, result });
      for (const hook of this.hooks.list()) {
        await hook.afterTool?.({ sessionId: this.id, turnId }, call, result);
      }
      return result;
    }

    yield this.event({ type: 'tool.started', turnId, call });
    const queuedProgress: AgentEvent[] = [];
    const context: ToolExecutionContext = {
      sessionId: this.id,
      turnId,
      toolCallId: call.id,
      workingDirectory: this.workingDirectory,
      signal: this.activeController?.signal ?? AbortSignal.abort(),
      messages: this.messages,
      reportProgress: (message, data) => {
        queuedProgress.push(
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
      const output = await tool.execute(parsed.data, context);
      for (const progressEvent of queuedProgress) yield progressEvent;
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
        isError: false,
        ...(output.metadata === undefined && Object.keys(artifactMetadata).length === 0
          ? {}
          : { metadata: { ...output.metadata, ...artifactMetadata } }),
      };
      yield this.event({ type: 'tool.completed', turnId, result });
      return result;
    } catch (error) {
      for (const progressEvent of queuedProgress) yield progressEvent;
      const result = this.toolError(call.id, errorMessage(error));
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
    return event;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private throwIfAborted(): void {
    if (this.activeController?.signal.aborted) throw new AgentAbortError();
  }

  private async persist(): Promise<void> {
    if (!this.sessionStore) return;
    const stored: StoredSession = {
      version: 1,
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      messages: structuredClone(this.history),
      metadata: structuredClone(this.metadata),
    };
    await this.sessionStore.save(stored);
  }
}

function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return (
    status === 413 ||
    /prompt.{0,20}(too long|context|large)|context.{0,20}(window|length|limit)/i.test(error.message)
  );
}

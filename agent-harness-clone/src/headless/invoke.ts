import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '../artifacts/artifact-store.js';
import { LocalProjectContextProvider } from '../context/project-context.js';
import { createAgentSession, type AgentSession } from '../core/agent-session.js';
import { AgentHarnessError } from '../core/errors.js';
import type { AgentEvent } from '../core/events.js';
import type { AgentMessage } from '../core/messages.js';
import type { McpElicitationHandler } from '../mcp/client.js';
import type { ModelUsage, StopReason } from '../models/provider.js';
import { RulePermissionHandler } from '../permissions/rule-permission-handler.js';
import type { ResolvedAgent } from '../platform/agent-registry.js';
import { LocalRuntimeHost, scrubbedEnvironment } from '../runtime/local-runtime-host.js';
import {
  emitLog,
  type EventSink,
  type LogContext,
  type LogSink,
} from '../services/observability.js';
import type { SessionStore } from '../sessions/session-store.js';
import { createBuiltinTools, type BuiltinToolOptions } from '../tools/builtin/index.js';
import { createWebTools, type WebToolsOptions } from '../tools/web/index.js';
import type { Tool } from '../tools/tool.js';
import { resolveInlineAgent } from './inline-agent.js';
import { invocationPayloadSchema, type InvocationPayload } from './payload.js';

/**
 * Runs one payload to completion, or streams the events of one payload.
 *
 * Nothing here reads MongoDB, S3, or a required environment variable. The payload is
 * the whole configuration, so a process built on this can be handed a JSON object and
 * produce an answer — which is what makes it deployable as a stateless function,
 * behind a queue, or as a container that scales to zero without a database beside it.
 *
 * The tradeoffs that come with that, stated once:
 *
 * - Credentials arrive on the request. A stored record has an operator script and an
 *   audit trail in front of it; a payload has whatever the transport put there.
 * - There is no history unless a `sessionStore` is supplied, so by default each
 *   payload is a fresh conversation.
 * - Tool permissions come from the payload too, so a caller can hand itself `bypass`.
 *   `HeadlessRunOptions.permissionCeiling` exists to take that back.
 */

export type HeadlessRunOptions = {
  /**
   * Parent of the per-run directory a payload without `workingDirectory` gets.
   * Defaults to a `agent-harness-headless` directory under the OS temp dir.
   */
  workspaceRoot?: string;
  /**
   * Which builtins the host offers. `agent.tools` is checked against these names, so
   * narrowing this narrows what any payload can ask for.
   */
  builtinToolOptions?: BuiltinToolOptions;
  /**
   * The network tools. `web_fetch` is offered unless turned off; `web_search` needs a
   * provider and is simply absent without one, so a deployment with no search
   * credential offers a catalogue one tool shorter rather than failing to start.
   *
   * Set to `false` to withhold both, which is the right choice for a deployment whose
   * payloads should not reach the internet.
   */
  webToolOptions?: WebToolsOptions | false;
  /** Offered last, so a supplied tool cannot shadow one of the above. */
  additionalTools?: readonly Tool[];
  /**
   * The environment spawned commands receive. Defaults to `scrubbedEnvironment()`,
   * which drops everything outside the allowlist — worth keeping, because a payload
   * can reach a shell tool while this process's environment may hold unrelated keys.
   */
  shellEnvironment?: NodeJS.ProcessEnv;
  /**
   * Enables `payload.sessionId` to continue an earlier conversation. Absent leaves
   * every run stateless, which is the headless default.
   */
  sessionStore?: SessionStore;
  artifactStore?: ArtifactStore;
  eventSink?: EventSink;
  /**
   * Structured JSON-ready lifecycle records. The process entrypoint wires this to
   * stdout, which AgentCore forwards to CloudWatch.
   */
  logSink?: LogSink;
  /** Host correlation fields, such as request and AgentCore runtime session ids. */
  logContext?: LogContext;
  /** Correlation id supplied by a transport; generated when omitted. */
  invocationId?: string;
  elicitationHandler?: McpElicitationHandler;
  /**
   * Caps `payload.permissionMode`. Set it to `plan` to refuse every state-changing
   * tool regardless of what a payload asks for, or `deny` to refuse all tools. Absent
   * lets the payload decide, including `bypass`.
   */
  permissionCeiling?: 'plan' | 'deny';
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
};

export type HeadlessToolSummary = {
  name: string;
  calls: number;
  errors: number;
};

export type HeadlessResult = {
  status: 'success' | 'error';
  sessionId: string;
  agentName: string;
  /** Every assistant text delta, concatenated. The answer, for most callers. */
  output: string;
  messages: readonly AgentMessage[];
  /** Where the file and shell tools were rooted. Not deleted; see `runWorkspace`. */
  workingDirectory: string;
  stopReason?: StopReason | 'closed';
  turns: number;
  usage: ModelUsage;
  tools: readonly HeadlessToolSummary[];
  /** Present only when `payload.includeEvents` was set. */
  events?: readonly AgentEvent[];
  durationMs: number;
  error?: { code: string; message: string; recoverable: boolean };
};

/**
 * Validates a payload, runs it, and returns the answer with what it cost.
 *
 * Throws only for a payload this runner cannot act on — a schema failure, an agent
 * that names a tool the host does not offer, an MCP server that will not connect.
 * A failure *during* the turn is reported as `status: 'error'` on a result that still
 * carries the partial output and the usage, because a run that spent tokens and then
 * hit a model error has produced information the caller should see.
 */
export async function invokeHeadless(
  payload: unknown,
  options: HeadlessRunOptions = {},
): Promise<HeadlessResult> {
  const started = Date.now();
  const invocationId = options.invocationId ?? randomUUID();
  const baseContext: LogContext = {
    ...(options.logContext ?? {}),
    invocationId,
    invocationMode: 'buffered',
  };
  let phase = 'validation';
  let prepared: PreparedRun | undefined;
  log(options, baseContext, {
    event: 'invocation.started',
    payload,
  });
  try {
    const parsed = parsePayload(payload);
    const sessionId = parsed.sessionId ?? invocationId;
    const context = { ...baseContext, sessionId };
    log(options, context, {
      event: 'invocation.payload.validated',
      agentName: parsed.agent.name,
      modelProvider: parsed.modelProvider.name,
      mcpServers: parsed.mcpServers.map((server) => server.name),
      skills: parsed.skills.map((skill) => skill.name),
    });

    phase = 'preparation';
    prepared = await prepare(parsed, options, sessionId, context);
    phase = 'execution';
    const collected: AgentEvent[] = [];
    const totals = new RunTotals();
    for await (const event of prepared.session.run({
      prompt: parsed.prompt,
      ...(Object.keys(parsed.metadata).length === 0 ? {} : { metadata: parsed.metadata }),
    })) {
      totals.observe(event);
      if (parsed.includeEvents) collected.push(event);
    }
    const result = {
      ...totals.result(prepared, Date.now() - started),
      ...(parsed.includeEvents ? { events: collected } : {}),
    };
    phase = 'cleanup';
    const closing = prepared;
    prepared = undefined;
    await closePrepared(closing, options, context);
    log(options, context, {
      ...(result.status === 'error' ? { level: 'error' as const } : {}),
      event: 'invocation.completed',
      status: result.status,
      durationMs: Date.now() - started,
      result,
    });
    return result;
  } catch (error) {
    if (prepared) {
      phase = 'cleanup';
      const closing = prepared;
      prepared = undefined;
      try {
        await closePrepared(closing, options, {
          ...baseContext,
          sessionId: closing.sessionId,
        });
      } catch (cleanupError) {
        log(options, baseContext, {
          level: 'error',
          event: 'invocation.failed',
          phase,
          durationMs: Date.now() - started,
          error: describeError(cleanupError),
          causedBy: describeError(error),
        });
        throw cleanupError;
      }
    }
    log(options, baseContext, {
      level: 'error',
      event: 'invocation.failed',
      phase,
      durationMs: Date.now() - started,
      error: describeError(error),
    });
    throw error;
  }
}

/**
 * The same run, as the events it produces.
 *
 * Yields `AgentEvent` verbatim rather than a reduced shape, so a transport can
 * serialize them straight through and a caller sees the same protocol the SSE and
 * gateway adapters emit. `finally` closes the session and the agent, so an abandoned
 * generator does not leave MCP processes running.
 */
export async function* streamHeadless(
  payload: unknown,
  options: HeadlessRunOptions = {},
): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const invocationId = options.invocationId ?? randomUUID();
  const baseContext: LogContext = {
    ...(options.logContext ?? {}),
    invocationId,
    invocationMode: 'stream',
  };
  let context = baseContext;
  let phase = 'validation';
  let prepared: PreparedRun | undefined;
  let completed = false;
  let failed = false;
  let runError = false;
  let terminalEvent: AgentEvent | undefined;
  log(options, baseContext, {
    event: 'invocation.started',
    payload,
  });
  try {
    const parsed = parsePayload(payload);
    const sessionId = parsed.sessionId ?? invocationId;
    context = { ...baseContext, sessionId };
    log(options, context, {
      event: 'invocation.payload.validated',
      agentName: parsed.agent.name,
      modelProvider: parsed.modelProvider.name,
      mcpServers: parsed.mcpServers.map((server) => server.name),
      skills: parsed.skills.map((skill) => skill.name),
    });
    phase = 'preparation';
    prepared = await prepare(parsed, options, sessionId, context);
    phase = 'execution';
    for await (const event of prepared.session.run({
      prompt: parsed.prompt,
      ...(Object.keys(parsed.metadata).length === 0 ? {} : { metadata: parsed.metadata }),
    })) {
      terminalEvent = event;
      if (event.type === 'error') runError = true;
      yield event;
    }
    completed = true;
  } catch (error) {
    failed = true;
    log(options, context, {
      level: 'error',
      event: 'invocation.failed',
      phase,
      durationMs: Date.now() - started,
      error: describeError(error),
    });
    throw error;
  } finally {
    if (prepared) {
      phase = 'cleanup';
      try {
        await closePrepared(prepared, options, context);
      } catch (error) {
        log(options, context, {
          level: 'error',
          event: 'invocation.failed',
          phase,
          durationMs: Date.now() - started,
          error: describeError(error),
        });
        throw error;
      }
    }
    if (completed) {
      log(options, context, {
        ...(runError ? { level: 'error' as const } : {}),
        event: 'invocation.completed',
        status: runError ? 'error' : 'success',
        terminalEvent,
        durationMs: Date.now() - started,
      });
    } else if (!failed) {
      log(options, context, {
        level: 'warn',
        event: 'invocation.cancelled',
        phase,
        terminalEvent,
        durationMs: Date.now() - started,
      });
    }
  }
}

/**
 * Wrapped in `AgentHarnessError` so every caller gets one error type with a code to
 * branch on, rather than a `ZodError` from this path and a harness error from the
 * next. The issue list is flattened into the message because a transport returning
 * this to a caller has one string to put it in.
 */
export function parsePayload(value: unknown): InvocationPayload {
  const result = invocationPayloadSchema.safeParse(value);
  if (result.success) return result.data;
  throw new AgentHarnessError(
    `Invalid invocation payload: ${formatIssues(result.error)}`,
    'HEADLESS_PAYLOAD_INVALID',
  );
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

type PreparedRun = {
  session: AgentSession;
  agent: ResolvedAgent;
  sessionId: string;
  workingDirectory: string;
  close(): Promise<void>;
};

/**
 * Everything between a validated payload and a runnable session.
 *
 * Ordered so the cheap failures come first: the workspace is created, then the agent
 * is assembled — which is where a bad credential, a missing tool, or an unreachable
 * MCP server surfaces — and only then is the session built. If assembly throws, the
 * agent's own `close` has already run, so no connection is left open.
 */
async function prepare(
  payload: InvocationPayload,
  options: HeadlessRunOptions,
  sessionId: string,
  logContext: LogContext,
): Promise<PreparedRun> {
  const started = Date.now();
  log(options, logContext, {
    event: 'invocation.preparation.started',
    sessionId,
  });
  const workingDirectory = await runWorkspace(payload, options, sessionId);
  log(options, logContext, {
    event: 'invocation.workspace.ready',
    sessionId,
    workingDirectory,
  });
  const shellEnvironment = options.shellEnvironment ?? scrubbedEnvironment();
  const runtime = new LocalRuntimeHost(workingDirectory, { env: shellEnvironment });
  const localTools = headlessToolCatalogue(runtime, options);

  log(options, logContext, {
    event: 'agent.resolution.started',
    sessionId,
    agentName: payload.agent.name,
    modelProvider: {
      name: payload.modelProvider.name,
      provider: payload.modelProvider.provider,
      model: payload.modelProvider.model,
      baseURL: payload.modelProvider.baseURL,
    },
    localTools: localTools.map((tool) => tool.name),
    mcpServers: payload.mcpServers.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
    })),
  });
  const registryLogger =
    options.logger === undefined && options.logSink === undefined
      ? undefined
      : (message: string): void => {
          if (options.logger) {
            options.logger(message);
          } else {
            log(options, logContext, {
              level: 'warn',
              event: 'runtime.warning',
              sessionId,
              message,
            });
          }
        };
  let agent: ResolvedAgent;
  try {
    agent = await resolveInlineAgent(payload, {
      localTools,
      ...(options.elicitationHandler === undefined
        ? {}
        : { elicitationHandler: options.elicitationHandler }),
      ...(registryLogger === undefined ? {} : { logger: registryLogger }),
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      logContext,
    });
  } catch (error) {
    log(options, logContext, {
      level: 'error',
      event: 'agent.resolution.failed',
      sessionId,
      agentName: payload.agent.name,
      durationMs: Date.now() - started,
      error: describeError(error),
    });
    throw error;
  }
  log(options, logContext, {
    event: 'agent.resolution.completed',
    sessionId,
    agentName: agent.record.name,
    provider: agent.provider.name,
    model: agent.model ?? agent.modelProvider.model,
    tools: agent.tools.map((tool) => tool.name),
    skills: agent.skillRecords.map((skill) => skill.name),
    mcpServers: agent.mcpRecords.map((server) => server.name),
    durationMs: Date.now() - started,
  });

  try {
    // Only consulted when a store was supplied. Without one, a repeated `sessionId`
    // names a workspace that already exists and a conversation that starts over,
    // which is the honest behaviour for a stateless runner.
    const stored = payload.sessionId
      ? await options.sessionStore?.load(payload.sessionId)
      : undefined;

    const session = createAgentSession({
      sessionId,
      provider: agent.provider,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      systemPrompt: agent.systemPrompt,
      workingDirectory,
      tools: agent.tools,
      limits: agent.limits,
      permissionHandler: permissionHandler(payload, options),
      ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
      ...(stored === undefined ? {} : { initialMessages: stored.messages }),
      ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
      ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      logContext,
      projectContextProvider: new LocalProjectContextProvider(runtime),
      metadata: { ...payload.metadata, agentName: agent.record.name },
    });

    return {
      session,
      agent,
      sessionId,
      workingDirectory,
      close: async () => {
        await session.close();
        await agent.close();
      },
    };
  } catch (error) {
    log(options, logContext, {
      level: 'error',
      event: 'invocation.preparation.failed',
      sessionId,
      durationMs: Date.now() - started,
      error: describeError(error),
    });
    await agent.close();
    throw error;
  }
}

async function closePrepared(
  prepared: PreparedRun,
  options: HeadlessRunOptions,
  context: LogContext,
): Promise<void> {
  const started = Date.now();
  log(options, context, {
    event: 'invocation.cleanup.started',
    sessionId: prepared.sessionId,
  });
  try {
    await prepared.close();
    log(options, context, {
      event: 'invocation.cleanup.completed',
      sessionId: prepared.sessionId,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log(options, context, {
      level: 'error',
      event: 'invocation.cleanup.failed',
      sessionId: prepared.sessionId,
      durationMs: Date.now() - started,
      error: describeError(error),
    });
    throw error;
  }
}

function log(
  options: HeadlessRunOptions,
  context: LogContext,
  entry: Parameters<LogSink['log']>[0],
): void {
  emitLog(options.logSink, { ...context, ...entry });
}

function describeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
  recoverable?: boolean;
  stack?: string;
} {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof AgentHarnessError
      ? { code: error.code, recoverable: error.recoverable }
      : {}),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

/**
 * Every local tool this host offers, in the order a session receives them.
 *
 * The set is the one `AGENT_RUNTIME_SUPPORT.tools` names, so a payload that passes
 * the support gate is not then refused for naming a tool the host forgot to build.
 * A payload selects from these by name and omitting `agent.tools` takes all of them,
 * which is why the host's options are the real ceiling on what any caller can do.
 */
export function headlessToolCatalogue(
  runtime: LocalRuntimeHost,
  options: HeadlessRunOptions = {},
): readonly Tool[] {
  return [
    ...createBuiltinTools(runtime, options.builtinToolOptions ?? {}),
    ...(options.webToolOptions === false ? [] : createWebTools(options.webToolOptions ?? {})),
    ...(options.additionalTools ?? []),
  ];
}

/**
 * A payload without `workingDirectory` gets its own directory named for the session,
 * so concurrent payloads in one process cannot read or overwrite each other's files.
 *
 * It is not deleted. A run's output is often the files it wrote, and a caller that
 * streamed events has no chance to collect them before this returns; the path is on
 * the result so the caller can. A process that serves many payloads should sweep the
 * root, or pass `workspaceRoot` inside a volume with its own lifecycle.
 */
async function runWorkspace(
  payload: InvocationPayload,
  options: HeadlessRunOptions,
  sessionId: string,
): Promise<string> {
  const directory = payload.workingDirectory
    ? path.resolve(payload.workingDirectory)
    : path.join(
        options.workspaceRoot
          ? path.resolve(options.workspaceRoot)
          : path.join(os.tmpdir(), 'agent-harness-headless'),
        sessionId,
      );
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * The payload's rules, narrowed by the host's ceiling.
 *
 * `fallback` is `allow` or `deny` and never `ask`: asking suspends the run until a
 * second call answers, and no payload can send that answer, so a run that asked
 * would hang until the caller gave up.
 */
function permissionHandler(
  payload: InvocationPayload,
  options: HeadlessRunOptions,
): RulePermissionHandler {
  const mode =
    options.permissionCeiling === 'deny'
      ? 'deny'
      : options.permissionCeiling === 'plan' && payload.permissionMode !== 'deny'
        ? 'plan'
        : payload.permissionMode;
  return new RulePermissionHandler({
    mode,
    rules: payload.permissionRules.map((rule) => ({
      tool: rule.tool,
      decision: rule.decision,
      ...(rule.inputPattern === undefined ? {} : { inputPattern: rule.inputPattern }),
      ...(rule.source === undefined ? {} : { source: rule.source }),
    })),
    fallback: payload.permissionFallback,
  });
}

/** Folds the event stream into the counts and text the result reports. */
class RunTotals {
  private readonly text: string[] = [];
  private readonly toolCalls = new Map<string, HeadlessToolSummary>();
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  private turns = 0;
  private stopReason: StopReason | 'closed' | undefined;
  private failure: { code: string; message: string; recoverable: boolean } | undefined;

  observe(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant.text.delta':
        this.text.push(event.delta);
        break;
      case 'turn.completed':
        this.turns = Math.max(this.turns, event.turn);
        this.stopReason = event.reason;
        break;
      case 'session.completed':
        this.stopReason = event.reason;
        break;
      // Counted on `requested` rather than `started`, because a call the permission
      // handler denied never starts but does produce a `tool.completed` marked as an
      // error. Counting from `started` would attribute every denial to 'unknown' and
      // report zero calls for a tool the model asked for repeatedly.
      case 'tool.requested':
        this.toolNamesByCallId.set(event.call.id, event.call.name);
        this.summary(event.call.name).calls += 1;
        break;
      case 'tool.completed': {
        if (!event.result.isError) break;
        const name = this.toolNamesByCallId.get(event.result.toolCallId) ?? 'unknown';
        this.summary(name).errors += 1;
        break;
      }
      case 'usage.updated':
        this.addUsage(event.usage);
        break;
      case 'error':
        // First failure wins: a model error often produces a cascade, and the one
        // that started it is the one worth reporting.
        this.failure ??= {
          code: event.code,
          message: event.message,
          recoverable: event.recoverable,
        };
        break;
      default:
        break;
    }
  }

  result(prepared: PreparedRun, durationMs: number): HeadlessResult {
    return {
      status: this.failure ? 'error' : 'success',
      sessionId: prepared.sessionId,
      agentName: prepared.agent.record.name,
      output: this.text.join(''),
      messages: prepared.session.messages,
      workingDirectory: prepared.workingDirectory,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      turns: this.turns,
      usage: this.usage,
      tools: [...this.toolCalls.values()],
      durationMs,
      ...(this.failure === undefined ? {} : { error: this.failure }),
    };
  }

  private summary(name: string): HeadlessToolSummary {
    const existing = this.toolCalls.get(name);
    if (existing) return existing;
    const created: HeadlessToolSummary = { name, calls: 0, errors: 0 };
    this.toolCalls.set(name, created);
    return created;
  }

  private addUsage(usage: ModelUsage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens !== undefined) {
      this.usage.cacheReadTokens = (this.usage.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    }
    if (usage.cacheWriteTokens !== undefined) {
      this.usage.cacheWriteTokens = (this.usage.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    }
    if (usage.estimatedCostUsd !== undefined) {
      this.usage.estimatedCostUsd = (this.usage.estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
    }
  }
}

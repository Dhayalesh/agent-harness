import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { contextPolicyFromPercent } from '../context/context-manager.js';
import { ContextOrchestrator } from '../context/context-orchestrator.js';
import type { Artifact, ArtifactStore } from '../artifacts/artifact-store.js';
import type { ContentStore } from '../content/content-store.js';
import { LocalProjectContextProvider } from '../context/project-context.js';
import { createAgentSession, type AgentSession } from '../core/agent-session.js';
import { AgentHarnessError } from '../core/errors.js';
import { AsyncEventQueue } from '../core/event-queue.js';
import type {
  AgentEvent,
  ContextActionName,
  ContextStateCounts,
  RunPreparationStage,
  RunProgressReporter,
} from '../core/events.js';
import { textMessage, type AgentInput, type AgentMessage } from '../core/messages.js';
import { prepareAttachments } from '../files/attachments.js';
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
import {
  createTaskTool,
  routeChildPermission,
  type SubagentHost,
  type SubagentSpawnSpec,
} from '../agents/subagents.js';
import { resolveInlineAgent } from './inline-agent.js';

/**
 * Appended to the parent's system prompt when delegation is enabled. The working
 * method CodeGenie's orchestrator agent follows (`agent/prompt/orchestrator.txt`),
 * adapted for an agent that may also do work itself: plan, split into waves by
 * dependency, run each wave in parallel, reassess between waves, then verify.
 */
const ORCHESTRATOR_GUIDANCE = `# Working on large tasks

You can delegate work to subagents with the task tool. For a small task, just do it yourself. For a large or multi-part task:

1. Understand the task first. Use explore subagents to research the relevant files, patterns and architecture when that would take many reads.
2. Plan. Record the subtasks with todo_write so progress is visible, and note which files each subtask will touch.
3. Classify dependencies. Independent subtasks form a wave and run in parallel: issue their task calls together in one message. Subtasks that need an earlier result go in a later wave. Subtasks that may edit the same files must be in different waves.
4. Execute wave by wave. After each wave, read the results and reassess: update the plan if something failed, revealed new work, or changed what later subtasks need. Give every subagent the context it needs from earlier waves, because it cannot see this conversation.
5. Verify the combined result (build, tests, or inspection), then report what was done, what was verified, and anything left open.

Keep the todo list current: exactly one item in progress, and mark items completed as soon as they are done.`;
import { invocationPayloadSchema, type InvocationPayload } from './payload.js';

/**
 * Runs one payload to completion, or streams the events of one payload.
 *
 * Nothing here reads MongoDB. The payload is the whole agent configuration; skill
 * entries carry S3 addresses whose documents are fetched during preparation with the
 * host's AWS identity. A process built on this can still scale without a database or
 * per-agent state beside it.
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
  /** Replaces the SDK-backed S3 reader for skill documents. */
  skillContentStore?: ContentStore;
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
  /**
   * Session identity supplied by the transport, used when the payload names none.
   *
   * AgentCore sends its runtime session id on a header, and every invocation in one
   * session carries the same value. Without this the fallback is `invocationId`, which
   * is fresh per request — so a session's invocations would each log a different
   * `sessionId` and could not be grouped, which is what this exists to fix.
   *
   * The payload still wins: an explicit `payload.sessionId` names a conversation the
   * caller wants to resume, and that is a stronger statement of intent than a header
   * the transport attached.
   */
  sessionId?: string;
  elicitationHandler?: McpElicitationHandler;
  /**
   * Caps `payload.permissionMode`. Set it to `plan` to refuse every state-changing
   * tool regardless of what a payload asks for, or `deny` to refuse all tools. Absent
   * lets the payload decide, including `bypass`.
   */
  permissionCeiling?: 'plan' | 'deny';
  /**
   * Allows `permissionFallback: 'ask'`, which suspends the run until something
   * answers the `permission.requested` event.
   *
   * Off by default and refused outright in `invokeHeadless`: a buffered call has
   * no one watching, so an asking run would hang until its caller timed out. A
   * transport sets this only when it is streaming *and* it has a route that can
   * deliver the answer back into the session.
   */
  interactivePermissions?: boolean;
  /**
   * Reports preparation progress. `streamHeadless` supplies its own so the
   * progress reaches the stream; a caller may set one to observe a buffered run.
   */
  onProgress?: RunProgressReporter;
  /**
   * Receives the session as soon as it exists, before the first event.
   *
   * The seam a control channel needs: answering a permission request means
   * calling `respondToPermission` on this exact session, and a generator yielding
   * events has no other way to hand out a reference to it.
   */
  onSession?: (session: AgentSession) => void;
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
  /**
   * Optional LLM-backed compaction summarizer. When supplied, the
   * DynamicCompactingContextManager uses it to produce Pi-style structured
   * summaries instead of falling back to the deterministic algorithm.
   * Configure via `COMPACTION_MODEL` pointing at a Bedrock model.
   */
  compactionSummarizer?: import('../context/context-manager.js').CompactionSummarizer;
};

export type HeadlessToolSummary = {
  name: string;
  calls: number;
  errors: number;
};

/**
 * Usage for one model request inside an agent run.
 *
 * A single model request may ask for several tools, so the call ids are kept as a
 * group. Consumers can show the usage beside every related tool while still making
 * it clear that the number is shared rather than charging it once per tool.
 */
export type HeadlessUsageDetail = {
  turnId: string;
  turn?: number;
  usage?: ModelUsage;
  toolCallIds: readonly string[];
};

export type HeadlessResult = {
  status: 'success' | 'error';
  sessionId: string;
  agentName: string;
  session: HeadlessSessionInfo;
  /**
   * Visible conversational output. Also retained when `response.type` is
   * `files`, allowing chat clients to show the model's accompanying narrative.
   */
  output: string;
  /** Discriminated presentation contract for chat clients. */
  response: HeadlessResponse;
  /** Response files created during the run. Also present on the `files` response. */
  artifacts: readonly Artifact[];
  messages: readonly AgentMessage[];
  /** Where the file and shell tools were rooted. Not deleted; see `runWorkspace`. */
  workingDirectory: string;
  stopReason?: StopReason | 'closed';
  turns: number;
  usage: ModelUsage;
  /** Per-model-request usage, including the final response-only request. */
  usageDetails: readonly HeadlessUsageDetail[];
  tools: readonly HeadlessToolSummary[];
  /**
   * How full the model context was on the last turn of this run.
   *
   * Reported so a buffered caller can show a usage meter without reading the event
   * stream. Absent when the context layer reported no budget — a passthrough
   * manager with no model capabilities supplied.
   */
  context?: HeadlessContextUsage;
  /** Present only when `payload.includeEvents` was set. */
  events?: readonly AgentEvent[];
  durationMs: number;
  /**
   * The run's agentic shape, for a buffered caller that did not read the events:
   * the final plan, each delegated subagent, and the interventions the loop made.
   * Absent for a run with none of these.
   */
  activity?: HeadlessActivity;
  error?: { code: string; message: string; recoverable: boolean };
};

export type HeadlessSubagentSummary = {
  taskId: string;
  toolCallId: string;
  description: string;
  agentType: string;
  resumed: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'max_turns';
  turns: number;
  toolCalls: number;
  durationMs?: number;
  summary?: string;
  usage?: ModelUsage;
  error?: string;
};

export type HeadlessActivity = {
  plan?: { content: string; status: string; activeForm: string }[];
  subagents?: HeadlessSubagentSummary[];
  interventions?: { kind: string; message: string; turnId: string }[];
};

/** How many turns of context history a result carries. Bounded; the tail is kept. */
const CONTEXT_TIMELINE_LIMIT = 40;

/**
 * One turn's context reading and what the layer did about it.
 *
 * Enough to render a timeline and nothing more — no message counts to misread as
 * content, no state items, no text.
 */
export type ContextTimelineEntry = {
  turn?: number;
  usedPercent: number;
  action?: ContextActionName;
  compacted?: boolean;
};

/** The last `context.usage` of a run, plus whether anything was compacted during it. */
export type HeadlessContextUsage = {
  usedTokens: number;
  budgetTokens: number;
  contextWindow?: number;
  reservedOutputTokens?: number;
  usedPercent: number;
  /** True when any turn in this run was compacted. */
  compacted: boolean;
  /** How many turns were compacted. */
  compactions: number;
  /** The run's high water mark, before any turn's compaction relieved it. */
  peakTokens?: number;
  /** `peakTokens` as a percentage of the budget, one decimal. */
  peakPercent?: number;
  /** Which threshold the last measurement crossed. */
  pressure?: 'nominal' | 'warning' | 'aggressive' | 'critical';
  /**
   * The most expensive automatic action the last turn took.
   *
   * Every field from here down is present only when an orchestrating context manager
   * prepared the run, which is the default. A caller that supplied its own manager
   * gets the same shape it always did.
   */
  action?: ContextActionName;
  strategy?: 'passthrough' | 'deterministic' | 'llm-summarization';
  verification?: 'passed' | 'recovered' | 'failed';
  /** State categories the verifier confirmed survived. */
  preserved?: readonly string[];
  /** History tiers that were compressed. */
  compressed?: readonly string[];
  /** Counts per state category, for a client that explains what is in the context. */
  state?: ContextStateCounts;
  /** Per-turn readings, bounded to the last 40. */
  timeline?: readonly ContextTimelineEntry[];
};

export type HeadlessResponse =
  { type: 'text'; text: string } | { type: 'files'; files: readonly Artifact[] };

export type HeadlessSessionInfo = {
  mode: 'persistent' | 'stateless';
  storage: 'none' | 'memory' | 'file' | 's3' | 'custom';
  resumed: boolean;
  origin: 'new' | 'store' | 'client_history' | 'stateless';
  historyMessageCount: number;
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
    // Present from the first line rather than only after validation. A payload that
    // fails to parse still belongs to the session that sent it, and a reader
    // filtering on `sessionId` should see that failure too.
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
  let phase = 'validation';
  let prepared: PreparedRun | undefined;
  let context: LogContext = baseContext;
  log(options, baseContext, {
    event: 'invocation.started',
    payloadSummary: summarizeInvocationPayload(payload),
  });
  log(options, baseContext, {
    level: 'debug',
    event: 'invocation.payload.received',
    payload,
  });
  try {
    const parsed = parsePayload(payload);
    const sessionId = resolveSessionId(parsed, options, invocationId);
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
    const collected: AgentEvent[] = [];
    const totals = new RunTotals();
    const operationEvents =
      parsed.operation === 'compact'
        ? prepared.session.compactContext()
        : prepared.session.run(runInput(parsed));
    for await (const event of operationEvents) {
      totals.observe(event);
      if (parsed.includeEvents) collected.push(event);
    }
    const result = {
      ...totals.result(prepared, Date.now() - started),
      ...(parsed.includeEvents ? { events: collected } : {}),
    };
    log(options, context, {
      level: 'debug',
      event: 'invocation.result.details',
      result,
    });
    phase = 'cleanup';
    const closing = prepared;
    prepared = undefined;
    await closePrepared(closing, options, context);
    log(options, context, {
      ...(result.status === 'error' ? { level: 'error' as const } : {}),
      event: 'invocation.completed',
      status: result.status,
      durationMs: Date.now() - started,
      ...resultForLog(result),
    });
    return result;
  } catch (error) {
    const failurePhase = phase;
    if (prepared) {
      const closing = prepared;
      prepared = undefined;
      try {
        await closePrepared(closing, options, context);
      } catch (cleanupError) {
        log(options, context, {
          level: 'error',
          event: 'invocation.failed',
          phase: 'cleanup',
          durationMs: Date.now() - started,
          error: describeError(cleanupError),
          causedBy: describeError(error),
        });
        throw cleanupError;
      }
    }
    log(options, context, {
      level: 'error',
      event: 'invocation.failed',
      phase: failurePhase,
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
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
  let context = baseContext;
  let phase = 'validation';
  let prepared: PreparedRun | undefined;
  let preparing:
    Promise<{ ok: true; value: PreparedRun } | { ok: false; error: unknown }> | undefined;
  let completed = false;
  let failed = false;
  let runError = false;
  let terminalEvent: AgentEvent | undefined;
  let streamSummary: Record<string, unknown> | undefined;
  log(options, baseContext, {
    event: 'invocation.started',
    payloadSummary: summarizeInvocationPayload(payload),
  });
  log(options, baseContext, {
    level: 'debug',
    event: 'invocation.payload.received',
    payload,
  });
  try {
    const parsed = parsePayload(payload);
    const sessionId = resolveSessionId(parsed, options, invocationId);
    context = { ...baseContext, sessionId };
    log(options, context, {
      event: 'invocation.payload.validated',
      agentName: parsed.agent.name,
      modelProvider: parsed.modelProvider.name,
      mcpServers: parsed.mcpServers.map((server) => server.name),
      skills: parsed.skills.map((skill) => skill.name),
    });
    phase = 'preparation';
    // Preparation is the longest silence in a run — a stdio MCP server may have to
    // be installed before it answers — so it reports rather than waits. The queue
    // exists because the registry reports through a callback several frames below
    // this generator; see `AsyncEventQueue`.
    const queue = new AsyncEventQueue<AgentEvent>();
    const channel = preparationChannel(sessionId, options, context, queue);
    yield channel.emit('workspace', 'Preparing the run workspace');
    yield channel.emit('agent', `Assembling agent ${parsed.agent.name}`, {
      modelProvider: parsed.modelProvider.name,
      model: parsed.agent.model ?? parsed.modelProvider.model,
      mcpServers: parsed.mcpServers.length,
      skills: parsed.skills.length,
    });
    preparing = prepare(parsed, options, sessionId, context, channel).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    void preparing.then(() => queue.close());
    yield* queue.drain();
    const settled = await preparing;
    if (!settled.ok) throw settled.error;
    prepared = settled.value;
    phase = 'execution';
    const totals = new RunTotals();
    const operationEvents =
      parsed.operation === 'compact'
        ? prepared.session.compactContext()
        : prepared.session.run(runInput(parsed));
    for await (const event of operationEvents) {
      terminalEvent = event;
      if (event.type === 'error') runError = true;
      totals.observe(event);
      yield event;
    }
    streamSummary = resultForLog(totals.result(prepared, Date.now() - started));
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
    const terminalPhase = phase;
    // A consumer can leave while preparation is still producing progress events. In
    // that case the promise may finish after control enters `finally`; claim its
    // result here so the just-created skill directory and MCP connections are closed.
    if (!prepared && preparing) {
      const settled = await preparing;
      if (settled.ok) prepared = settled.value;
    }
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
        ...(streamSummary ?? {}),
      });
    } else if (!failed) {
      log(options, context, {
        level: 'warn',
        event: 'invocation.cancelled',
        phase: terminalPhase,
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

/**
 * Which session this invocation belongs to, most explicit source first.
 *
 * 1. `payload.sessionId` — the caller naming a conversation to resume.
 * 2. `options.sessionId` — the transport's session identity, which for AgentCore is
 *    the runtime session header and is stable across every invocation in a session.
 * 3. `invocationId` — a fresh id, leaving the run stateless and self-identifying.
 *
 * The ordering is what makes a session's invocations group in CloudWatch: before
 * step 2 existed, a payload without `sessionId` fell straight to step 3, so each
 * invocation logged a different `sessionId` and nothing tied them together.
 *
 * This is also the id `prepare` uses for the session store and the workspace
 * directory, so grouping the logs and continuing the conversation stay the same
 * decision rather than drifting apart.
 */
function resolveSessionId(
  payload: InvocationPayload,
  options: HeadlessRunOptions,
  invocationId: string,
): string {
  return payload.sessionId ?? options.sessionId ?? invocationId;
}

type PreparedRun = {
  session: AgentSession;
  agent: ResolvedAgent;
  sessionId: string;
  sessionInfo: Omit<HeadlessSessionInfo, 'historyMessageCount'>;
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
  progress?: RunProgressChannel,
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
    modelProvider: payload.modelProvider.name,
    provider: payload.modelProvider.provider,
    model: payload.agent.model ?? payload.modelProvider.model,
    localToolCount: localTools.length,
    localTools: localTools.map((tool) => tool.name),
    skillCount: payload.skills.length,
    skills: payload.skills.map((skill) => skill.name),
    mcpServerCount: payload.mcpServers.length,
    mcpServers: payload.mcpServers.map((server) => server.name),
  });
  log(options, logContext, {
    level: 'debug',
    event: 'agent.resolution.details',
    sessionId,
    agentName: payload.agent.name,
    modelProvider: {
      name: payload.modelProvider.name,
      provider: payload.modelProvider.provider,
      model: payload.modelProvider.model,
      baseURL: payload.modelProvider.baseURL,
    },
    mcpServers: payload.mcpServers.map((server) => ({
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
    })),
  });
  // Model and MCP registries emit their own structured warning records. A no-op
  // legacy logger avoids writing the same warning a second time when only logSink is
  // configured; callers that explicitly provide logger still receive it.
  const registryLogger =
    options.logger ?? (options.logSink === undefined ? undefined : (_message: string) => undefined);
  let agent: ResolvedAgent;
  try {
    // The stream's own channel wins; `options.onProgress` is what a buffered
    // caller sets when it wants the same milestones without the events.
    const onProgress = progress?.report ?? options.onProgress;
    agent = await resolveInlineAgent(payload, {
      localTools,
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(options.elicitationHandler === undefined
        ? {}
        : { elicitationHandler: options.elicitationHandler }),
      ...(registryLogger === undefined ? {} : { logger: registryLogger }),
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      ...(options.skillContentStore === undefined
        ? {}
        : { skillContentStore: options.skillContentStore }),
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
    toolCount: agent.tools.length,
    skillCount: agent.skillRecords.length,
    mcpServerCount: agent.mcpRecords.length,
    durationMs: Date.now() - started,
  });
  log(options, logContext, {
    level: 'debug',
    event: 'agent.catalog.resolved',
    sessionId,
    agentName: agent.record.name,
    tools: agent.tools.map((tool) => tool.name),
    skills: agent.skillRecords.map((skill) => skill.name),
    mcpServers: agent.mcpRecords.map((server) => server.name),
  });

  try {
    // Only consulted when a store was supplied. Without one, a repeated `sessionId`
    // names a workspace that already exists and a conversation that starts over,
    // which is the honest behaviour for a stateless runner.
    //
    // Loaded against the resolved `sessionId` rather than `payload.sessionId`, so a
    // session identified by the AgentCore header resumes like one named in the body.
    // Keying these differently is how a run could log a session id and still answer
    // with no memory of the invocation before it.
    //
    // `invocationId` is a fresh uuid, so a genuinely stateless run still finds
    // nothing here and starts clean.
    const mode = payload.session?.mode ?? (options.sessionStore ? 'persistent' : 'stateless');
    if (mode === 'persistent' && options.sessionStore === undefined) {
      throw new AgentHarnessError(
        'Persistent session mode requires a configured session store',
        'SESSION_STORE_REQUIRED',
      );
    }
    const stored = mode === 'persistent' ? await options.sessionStore?.load(sessionId) : undefined;
    const bootstrapMessages =
      stored === undefined && mode === 'persistent'
        ? (payload.session?.history.map((message) =>
            textMessage(
              message.id,
              message.role,
              message.content,
              message.createdAt ?? new Date().toISOString(),
            ),
          ) ?? [])
        : [];
    const initialMessages = stored?.messages ?? bootstrapMessages;
    const sessionInfo: Omit<HeadlessSessionInfo, 'historyMessageCount'> = {
      mode,
      storage: mode === 'stateless' ? 'none' : (options.sessionStore?.kind ?? 'custom'),
      resumed: stored !== undefined || bootstrapMessages.length > 0,
      origin:
        mode === 'stateless'
          ? 'stateless'
          : stored !== undefined
            ? 'store'
            : bootstrapMessages.length > 0
              ? 'client_history'
              : 'new',
    };

    progress?.report('ready', `Agent ${agent.record.name} is ready`, {
      tools: agent.tools.length,
      skills: agent.skillRecords.length,
      mcpServers: agent.mcpRecords.length,
      resumed: sessionInfo.resumed,
      sessionOrigin: sessionInfo.origin,
      historyMessageCount: initialMessages.length,
    });

    const permissions = permissionHandler(payload, options);
    const modelCapabilities = {
      contextWindow: agent.modelProvider.capabilities.contextWindow,
      maxOutputTokens: agent.modelProvider.capabilities.maxOutputTokens,
    };
    const contextManagerFor = () =>
      new ContextOrchestrator({
        ...(options.compactionSummarizer === undefined
          ? {}
          : { summarizer: options.compactionSummarizer }),
        ...(agent.limits.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: agent.limits.maxOutputTokens }),
        ...(agent.limits.compactionThresholdPercent === undefined
          ? {}
          : { policy: contextPolicyFromPercent(agent.limits.compactionThresholdPercent) }),
      });

    // Delegation. Children are ordinary sessions: same provider, workspace and
    // permission handler, each with its own context manager, so compaction happens
    // per child against the same model window. They persist to the same store under
    // their own ids, which is what lets a `task_id` resume on another replica.
    const orchestration = payload.orchestration;
    const subagentsEnabled = orchestration !== undefined && orchestration.subagents;
    const parentTools: Tool[] = [...agent.tools];
    const children: SubagentHost['children'] = new Map();
    if (subagentsEnabled) {
      const spawnChild = (
        spec: SubagentSpawnSpec,
        stored?: Awaited<ReturnType<SessionStore['load']>>,
      ) =>
        createAgentSession({
          sessionId: spec.taskId,
          provider: agent.provider,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          systemPrompt: [
            spec.type.inheritSystemPrompt ? agent.systemPrompt : undefined,
            spec.type.systemPrompt,
          ]
            .filter(Boolean)
            .join('\n\n'),
          workingDirectory,
          tools: spec.tools,
          limits: {
            ...agent.limits,
            maxTurns: spec.type.maxTurns ?? orchestration.subagentMaxTurns,
          },
          permissionHandler: permissions,
          ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
          ...(stored === undefined
            ? {}
            : {
                initialMessages: stored.messages,
                ...(stored.preparedContext === undefined
                  ? {}
                  : { preparedContext: stored.preparedContext }),
                sessionCreatedAt: stored.createdAt,
              }),
          ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
          logContext: { ...logContext, parentSessionId: sessionId, taskId: spec.taskId },
          projectContextProvider: new LocalProjectContextProvider(runtime),
          metadata: { parentSessionId: sessionId, agentType: spec.type.name },
          modelCapabilities,
          contextManager: contextManagerFor(),
          planOwner: spec.taskId,
        });
      parentTools.push(
        createTaskTool(
          {
            parentSessionId: sessionId,
            children,
            tools: () => agent.tools,
            newId: () => randomUUID().slice(0, 8),
            spawn: (spec) => spawnChild(spec),
            ...(options.sessionStore === undefined
              ? {}
              : {
                  resume: async (spec: SubagentSpawnSpec) => {
                    // Only a child of this parent may be resumed from it.
                    if (!spec.taskId.startsWith(`${sessionId}-task-`)) return undefined;
                    const stored = await options.sessionStore?.load(spec.taskId);
                    return stored === undefined ? undefined : spawnChild(spec, stored);
                  },
                }),
          },
          { maxConcurrent: orchestration.maxConcurrent },
        ),
      );
    }
    const systemPrompt =
      subagentsEnabled && orchestration.orchestratorGuidance
        ? `${agent.systemPrompt}\n\n${ORCHESTRATOR_GUIDANCE}`
        : agent.systemPrompt;

    const session = createAgentSession({
      sessionId,
      provider: agent.provider,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      systemPrompt,
      workingDirectory,
      tools: parentTools,
      limits: agent.limits,
      permissionHandler: permissions,
      delegatePermission: (requestId, decision) =>
        routeChildPermission(children, requestId, decision),
      ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
      ...(initialMessages.length === 0 ? {} : { initialMessages }),
      ...(stored?.preparedContext === undefined ? {} : { preparedContext: stored.preparedContext }),
      ...(stored === undefined ? {} : { sessionCreatedAt: stored.createdAt }),
      sessionState: sessionInfo,
      ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
      ...(options.eventSink === undefined ? {} : { eventSink: options.eventSink }),
      ...(options.logSink === undefined ? {} : { logSink: options.logSink }),
      logContext,
      projectContextProvider: new LocalProjectContextProvider(runtime),
      metadata: { ...payload.metadata, agentName: agent.record.name },
      // Pass model capabilities so the context manager derives a dynamic budget.
      modelCapabilities,
      ...(payload.compactContext ? { compactContext: true } : {}),
      // Built here rather than left to the session default because the record's
      // `compactionThresholdPercent` and the deployment's summarizer are two
      // independent inputs to the same policy, and only this layer sees both. A
      // summarizer is attached when one is configured (e.g. via COMPACTION_MODEL);
      // without one the same pipeline compacts using its deterministic fallback.
      //
      // The orchestrator owns a `DynamicCompactingContextManager` and delegates every
      // token it removes to it, so this is the same compaction behaviour with the
      // cheaper automatic stages in front and verification behind. The agent record
      // still names exactly one context setting.
      contextManager: contextManagerFor(),
      // Continues the numbering the preparation events already used, so one run
      // is one sequence from the first `run.preparing` to `session.completed`.
      ...(progress === undefined ? {} : { initialSequence: progress.count() }),
    });
    options.onSession?.(session);
    log(options, logContext, {
      event: 'invocation.preparation.completed',
      sessionId,
      agentName: agent.record.name,
      workingDirectory,
      toolCount: agent.tools.length,
      skillCount: agent.skillRecords.length,
      mcpServerCount: agent.mcpRecords.length,
      resumed: sessionInfo.resumed,
      sessionMode: sessionInfo.mode,
      sessionOrigin: sessionInfo.origin,
      historyMessageCount: initialMessages.length,
      durationMs: Date.now() - started,
    });

    return {
      session,
      agent,
      sessionId,
      sessionInfo,
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

/**
 * The preparation reporter, its own sequence counter, and the queue that carries
 * its events out to the generator.
 *
 * `emit` returns the event for the caller to yield directly; `report` is the
 * callback handed down to the registry, which cannot yield and so pushes instead.
 * Both share one counter, because the session continues it (`initialSequence`).
 */
type RunProgressChannel = {
  report: RunProgressReporter;
  emit: (stage: RunPreparationStage, message: string, data?: Record<string, unknown>) => AgentEvent;
  count: () => number;
};

function preparationChannel(
  sessionId: string,
  options: HeadlessRunOptions,
  logContext: LogContext,
  queue: AsyncEventQueue<AgentEvent>,
): RunProgressChannel {
  let sequence = 0;
  const build = (
    stage: RunPreparationStage,
    message: string,
    data?: Record<string, unknown>,
  ): AgentEvent => {
    const event: AgentEvent = {
      type: 'run.preparing',
      stage,
      message,
      ...(data === undefined ? {} : { data }),
      protocolVersion: 1,
      sequence: (sequence += 1),
      timestamp: new Date().toISOString(),
      sessionId,
    };
    try {
      options.eventSink?.onEvent(event);
    } catch {
      // Observability is never an execution dependency.
    }
    log(options, logContext, {
      level: 'debug',
      event: 'run.preparing',
      timestamp: event.timestamp,
      sessionId,
      eventSequence: event.sequence,
      stage,
      message,
      ...(data === undefined ? {} : { preparation: data }),
    });
    return event;
  };
  return {
    report: (stage, message, data) => queue.push(build(stage, message, data)),
    emit: build,
    count: () => sequence,
  };
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

function summarizeInvocationPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  }
  try {
    const payload = value as Record<string, unknown>;
    const agent =
      payload.agent !== null && typeof payload.agent === 'object' && !Array.isArray(payload.agent)
        ? (payload.agent as Record<string, unknown>)
        : undefined;
    const modelProvider =
      payload.modelProvider !== null &&
      typeof payload.modelProvider === 'object' &&
      !Array.isArray(payload.modelProvider)
        ? (payload.modelProvider as Record<string, unknown>)
        : undefined;
    return {
      type: 'object',
      ...(typeof payload.prompt === 'string' ? { promptChars: payload.prompt.length } : {}),
      ...(typeof agent?.name === 'string' ? { agentName: agent.name } : {}),
      ...(typeof modelProvider?.name === 'string' ? { modelProvider: modelProvider.name } : {}),
      ...(Array.isArray(payload.skills) ? { skillCount: payload.skills.length } : {}),
      ...(Array.isArray(payload.mcpServers) ? { mcpServerCount: payload.mcpServers.length } : {}),
      ...(typeof payload.sessionId === 'string' ? { hasExplicitSessionId: true } : {}),
    };
  } catch {
    // Payload introspection is diagnostic only and must never change invocation behavior.
    return { type: 'unreadable' };
  }
}

function resultForLog(result: HeadlessResult): Record<string, unknown> {
  const {
    messages,
    events,
    output,
    status: _status,
    sessionId: _sessionId,
    durationMs: _duration,
    ...summary
  } = result;
  return {
    ...summary,
    outputChars: output.length,
    messageCount: messages.length,
    ...(events === undefined ? {} : { eventCount: events.length }),
  };
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
    ...createBuiltinTools(runtime, {
      ...(options.builtinToolOptions ?? {}),
      ...(options.artifactStore === undefined ? {} : { artifactStore: options.artifactStore }),
    }),
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
  // Refused rather than silently downgraded to `deny`: a caller that asked to be
  // consulted and was quietly overruled would read the denials as the agent's
  // judgement instead of as its transport's.
  if (payload.permissionFallback === 'ask' && options.interactivePermissions !== true) {
    throw new AgentHarnessError(
      "permissionFallback 'ask' needs a transport that can deliver the answer: stream the " +
        'run and enable the run registry, or choose allow or deny.',
      'INTERACTIVE_PERMISSIONS_UNAVAILABLE',
    );
  }
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
/**
 * The one turn a payload describes.
 *
 * Attachments are folded in here rather than at each call site, so the buffered and
 * streaming paths cannot drift on how a file reaches the model.
 */
function runInput(parsed: InvocationPayload): AgentInput {
  const attachments = prepareAttachments(parsed.attachments, parsed.prompt);
  return {
    prompt: attachments.prompt,
    ...(attachments.images.length ? { images: attachments.images } : {}),
    ...(Object.keys(parsed.metadata).length === 0 ? {} : { metadata: parsed.metadata }),
  };
}

class RunTotals {
  private readonly text: string[] = [];
  private readonly artifacts: Artifact[] = [];
  private readonly toolCalls = new Map<string, HeadlessToolSummary>();
  private readonly toolNamesByCallId = new Map<string, string>();
  private readonly usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  private readonly usageDetails = new Map<string, HeadlessUsageDetail>();
  private turns = 0;
  private stopReason: StopReason | 'closed' | undefined;
  private failure: { code: string; message: string; recoverable: boolean } | undefined;
  private context: HeadlessContextUsage | undefined;
  private compactions = 0;
  private peakTokens: number | undefined;
  private peakPercent = 0;
  private readonly timeline: ContextTimelineEntry[] = [];
  private plan: HeadlessActivity['plan'];
  private readonly subagents = new Map<string, HeadlessSubagentSummary>();
  private readonly interventions: NonNullable<HeadlessActivity['interventions']>[number][] = [];

  observe(event: AgentEvent): void {
    switch (event.type) {
      case 'assistant.text.delta':
        this.text.push(event.delta);
        break;
      case 'artifact.created':
        this.artifacts.push(event.artifact);
        break;
      case 'turn.started':
        this.usageDetail(event.turnId).turn = event.turn;
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
        {
          const detail = this.usageDetail(event.turnId);
          if (!detail.toolCallIds.includes(event.call.id)) {
            detail.toolCallIds = [...detail.toolCallIds, event.call.id];
          }
        }
        break;
      case 'tool.completed': {
        if (!event.result.isError) break;
        const name = this.toolNamesByCallId.get(event.result.toolCallId) ?? 'unknown';
        this.summary(name).errors += 1;
        break;
      }
      case 'usage.updated':
        this.addUsage(event.usage);
        {
          const detail = this.usageDetail(event.turnId);
          detail.usage = addModelUsage(detail.usage, event.usage);
        }
        break;
      // Last one wins: the meter shows where the context stands now, which is what
      // the most recent turn measured.
      case 'context.usage':
        // The peak is the exception to last-one-wins. A run whose middle turn hit
        // the threshold and compacted ends on a low reading, and without the high
        // water mark the record cannot say that anything happened at all.
        {
          const candidate = event.peakTokens ?? event.usedTokens;
          if (this.peakTokens === undefined || candidate > this.peakTokens) {
            this.peakTokens = candidate;
            this.peakPercent = event.peakPercent ?? event.usedPercent;
          }
        }
        // One timeline entry per measured turn, kept as a bounded tail. A buffered
        // caller and a reopened chat both need to be able to say *when* the context
        // filled and what was done about it; the last reading alone cannot, because
        // the interesting turn is by definition not the last one.
        if (event.action !== undefined || event.turn !== undefined) {
          this.timeline.push({
            ...(event.turn === undefined ? {} : { turn: event.turn }),
            usedPercent: event.usedPercent,
            ...(event.action === undefined ? {} : { action: event.action }),
            ...(event.compacted ? { compacted: true } : {}),
          });
          if (this.timeline.length > CONTEXT_TIMELINE_LIMIT) this.timeline.shift();
        }
        this.context = {
          usedTokens: event.usedTokens,
          budgetTokens: event.budgetTokens,
          ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
          ...(event.reservedOutputTokens === undefined
            ? {}
            : { reservedOutputTokens: event.reservedOutputTokens }),
          usedPercent: event.usedPercent,
          compacted: this.compactions > 0 || event.compacted,
          compactions: this.compactions,
          ...(this.peakTokens === undefined
            ? {}
            : { peakTokens: this.peakTokens, peakPercent: this.peakPercent }),
          ...(event.pressure === undefined ? {} : { pressure: event.pressure }),
          ...(event.action === undefined ? {} : { action: event.action }),
          ...(event.strategy === undefined ? {} : { strategy: event.strategy }),
          ...(event.verification === undefined ? {} : { verification: event.verification }),
          ...(event.preserved === undefined ? {} : { preserved: event.preserved }),
          ...(event.compressed === undefined ? {} : { compressed: event.compressed }),
          ...(event.state === undefined ? {} : { state: event.state }),
          ...(this.timeline.length === 0 ? {} : { timeline: [...this.timeline] }),
        };
        break;
      case 'context.compaction.completed':
        this.compactions += 1;
        break;
      case 'plan.updated':
        if (event.owner === 'main') this.plan = event.todos.map((todo) => ({ ...todo }));
        break;
      case 'subagent.started':
        this.subagents.set(event.taskId, {
          taskId: event.taskId,
          toolCallId: event.toolCallId,
          description: event.description,
          agentType: event.agentType,
          resumed: event.resumed,
          status: 'running',
          turns: 0,
          toolCalls: 0,
        });
        break;
      case 'subagent.completed': {
        const existing = this.subagents.get(event.taskId);
        this.subagents.set(event.taskId, {
          taskId: event.taskId,
          toolCallId: event.toolCallId,
          description: existing?.description ?? '',
          agentType: existing?.agentType ?? 'general',
          resumed: existing?.resumed ?? false,
          status: event.status,
          turns: event.turns,
          toolCalls: event.toolCalls,
          durationMs: event.durationMs,
          summary: event.summary,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.error === undefined ? {} : { error: event.error }),
        });
        break;
      }
      case 'agent.intervention':
        this.interventions.push({ kind: event.kind, message: event.message, turnId: event.turnId });
        if (this.interventions.length > 20) this.interventions.shift();
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
    const activity = this.activity();
    const text = this.text.join('');
    const artifacts = [...this.artifacts];
    const response: HeadlessResponse =
      artifacts.length > 0 ? { type: 'files', files: artifacts } : { type: 'text', text };
    return {
      status: this.failure ? 'error' : 'success',
      sessionId: prepared.sessionId,
      agentName: prepared.agent.record.name,
      session: {
        ...prepared.sessionInfo,
        historyMessageCount: prepared.session.messages.length,
      },
      // `response.type` tells a client that files are the primary deliverable;
      // `output` still carries the model's accompanying conversational text.
      output: text,
      response,
      artifacts,
      messages: prepared.session.messages,
      workingDirectory: prepared.workingDirectory,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      turns: this.turns,
      usage: this.usage,
      usageDetails: [...this.usageDetails.values()],
      tools: [...this.toolCalls.values()],
      ...(this.context === undefined
        ? {}
        : { context: { ...this.context, compactions: this.compactions } }),
      durationMs,
      ...(activity === undefined ? {} : { activity }),
      ...(this.failure === undefined ? {} : { error: this.failure }),
    };
  }

  private activity(): HeadlessActivity | undefined {
    const subagents = [...this.subagents.values()];
    if (!this.plan?.length && subagents.length === 0 && this.interventions.length === 0) {
      return undefined;
    }
    return {
      ...(this.plan?.length ? { plan: this.plan } : {}),
      ...(subagents.length ? { subagents } : {}),
      ...(this.interventions.length ? { interventions: [...this.interventions] } : {}),
    };
  }

  private summary(name: string): HeadlessToolSummary {
    const existing = this.toolCalls.get(name);
    if (existing) return existing;
    const created: HeadlessToolSummary = { name, calls: 0, errors: 0 };
    this.toolCalls.set(name, created);
    return created;
  }

  private usageDetail(turnId: string): HeadlessUsageDetail {
    const existing = this.usageDetails.get(turnId);
    if (existing) return existing;
    const created: HeadlessUsageDetail = { turnId, toolCallIds: [] };
    this.usageDetails.set(turnId, created);
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
    if (usage.reasoningTokens !== undefined) {
      this.usage.reasoningTokens = (this.usage.reasoningTokens ?? 0) + usage.reasoningTokens;
    }
  }
}

function addModelUsage(current: ModelUsage | undefined, addition: ModelUsage): ModelUsage {
  const result: ModelUsage = {
    inputTokens: current?.inputTokens ?? 0,
    outputTokens: current?.outputTokens ?? 0,
  };
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'estimatedCostUsd',
  ] as const) {
    const value = addition[field];
    if (value !== undefined) result[field] = (result[field] ?? 0) + value;
  }
  return result;
}

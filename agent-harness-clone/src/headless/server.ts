import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AgentHarnessError } from '../core/errors.js';
import type { AgentEvent } from '../core/events.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import { invokeHeadless, streamHeadless, type HeadlessRunOptions } from './invoke.js';
import { RunRegistry, type RunRegistryOptions } from './run-registry.js';

/**
 * `POST /invocations` with a payload, `GET /ping` for a health probe.
 *
 * Deliberately stateless: there is no session map, no control token, and no second
 * endpoint to answer a permission request. One request carries the whole
 * configuration and gets the whole answer, so any instance can serve any request and
 * a replica can be added or removed without draining. That is the trade against
 * `agentcore-server.ts`, which holds sessions in memory and therefore needs the
 * caller pinned to one process — and needs a database to know what agent to build.
 *
 * The path and default port match the AgentCore Runtime contract, so this drops into
 * the same deployment as `service/agentcore.ts` without the caller changing anything
 * except the body it sends.
 */

/** Matches `AGENTCORE_PORT` / `AGENTCORE_HOST`, so the same container contract applies. */
export const HEADLESS_PORT = 8080;
export const HEADLESS_HOST = '0.0.0.0';
export const AGENTCORE_RUNTIME_SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
export const AWS_TRACE_HEADER = 'x-amzn-trace-id';
/**
 * Names the run to rejoin or to answer. Sent back on every registered stream, so
 * a caller that did not choose one still learns the id it was given.
 */
export const RUN_ID_HEADER = 'x-run-id';

export type HeadlessServerOptions = HeadlessRunOptions & {
  host?: string;
  port?: number;
  /**
   * Required in the `x-agent-service-key` header when set.
   *
   * Leaving it unset serves an unauthenticated endpoint that accepts a system
   * prompt, an arbitrary model endpoint with its credential, arbitrary MCP servers
   * including stdio ones that spawn processes, and a permission mode. That is remote
   * code execution to anyone who can reach the port. Unset is only appropriate
   * behind a front door that authenticates for you — an AgentCore runtime, an API
   * gateway, or a loopback bind.
   */
  serviceKey?: string;
  /**
   * Defaults to 8 MB, wider than the gateway server's 1 MB: a payload carries the
   * system prompt, model and MCP configuration, and skill references.
   */
  maxBodyBytes?: number;
  /** Concurrent runs allowed. Further requests get 429. Defaults to 8. */
  maxConcurrentRuns?: number;
  /**
   * Gap between SSE comment frames on an otherwise silent stream. Defaults to
   * 15s, under the 30–60s idle timeout most proxies apply.
   */
  keepAliveMs?: number;
  /**
   * Keeps runs addressable after the request that started them, which is what
   * `Last-Event-ID` resume and `permissionFallback: 'ask'` both need. Off by
   * default: it trades the property that any replica can serve any request, so
   * enable it only where a caller is pinned to one process — an AgentCore runtime
   * session is, a load-balanced pool is not.
   */
  resumableRuns?: boolean | RunRegistryOptions;
};

export type RunningHeadlessServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function startHeadlessServer(
  options: HeadlessServerOptions,
): Promise<RunningHeadlessServer> {
  const maxBodyBytes = options.maxBodyBytes ?? 8_000_000;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 8;
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const registry =
    options.resumableRuns === undefined || options.resumableRuns === false
      ? undefined
      : new RunRegistry(options.resumableRuns === true ? {} : options.resumableRuns);
  const {
    host: _host,
    port: _port,
    serviceKey,
    maxBodyBytes: _maxBodyBytes,
    maxConcurrentRuns: _maxConcurrentRuns,
    keepAliveMs: _keepAliveMs,
    resumableRuns: _resumableRuns,
    invocationId: _invocationId,
    // Dropped for the same reason as `invocationId`: both are per-invocation identity.
    // A server-wide value would label every request in the process as one session,
    // which is the inverse of the fan-out this change exists to fix. Each request
    // derives its own from the AgentCore header below.
    sessionId: _sessionId,
    ...runOptions
  } = options;
  let activeRuns = 0;
  // Tracked so `/ping` can report a status change without restating it on every probe.
  // See `writePing` for why that distinction is load-bearing.
  let busy = false;
  let statusChangedAtSeconds = Math.floor(Date.now() / 1000);

  const setBusy = (next: boolean): void => {
    if (next === busy) return;
    busy = next;
    statusChangedAtSeconds = Math.floor(Date.now() / 1000);
  };

  /**
   * `Healthy` when idle, `HealthyBusy` while a run is in flight.
   *
   * `HealthyBusy` is what keeps a long turn alive: AgentCore treats the session as
   * active while a container reports it, so the idle timeout does not reclaim a session
   * that is waiting on a model or a tool.
   *
   * `time_of_last_update` is sent only when the status actually changed. A timestamp
   * that advanced on every probe would read as a status that never settles, and the
   * idle timeout would then never fire: sessions would live to `MaxLifetime` and consume
   * the session quota until they did.
   */
  const writePing = (response: ServerResponse): void => {
    sendJson(response, 200, {
      status: busy ? 'HealthyBusy' : 'Healthy',
      time_of_last_update: statusChangedAtSeconds,
    });
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      emitLog(runOptions.logSink, {
        ...(runOptions.logContext ?? {}),
        level: 'error',
        event: 'http.request.unhandled',
        error: errorDetails(error),
      });
      if (runOptions.logSink === undefined) {
        process.stderr.write(`headless: unhandled request failure: ${describe(error)}\n`);
      }
      if (!response.headersSent) sendJson(response, 500, { error: describe(error) });
      response.end();
    });
  });

  /**
   * Resolves one `permission.requested` event. The decision reaches the suspended
   * run through the session the registry is holding; there is no other route
   * back into a turn that is already in flight.
   */
  async function answerPermission(
    request: IncomingMessage,
    response: ServerResponse,
    context: LogContext,
  ): Promise<void> {
    if (!registry) {
      rejected(runOptions.logSink, context, 404, 'Run registry is not enabled');
      sendJson(response, 404, {
        error: 'This server holds no runs, so there is nothing to answer. Enable resumableRuns.',
      });
      return;
    }
    let body: unknown;
    try {
      body = await readJson(request, 64_000);
    } catch (error) {
      rejected(runOptions.logSink, context, 400, describe(error));
      sendJson(response, 400, { error: describe(error) });
      return;
    }
    const decision = permissionDecision(body);
    if (!decision) {
      rejected(runOptions.logSink, context, 400, 'Invalid permission decision');
      sendJson(response, 400, {
        error: 'Expected { runId, requestId, decision } with decision "allow" or "deny"',
      });
      return;
    }
    const run = registry.get(decision.runId);
    const answered = run?.session?.respondToPermission(decision.requestId, decision.decision);
    emitLog(runOptions.logSink, {
      ...context,
      level: answered === true ? 'info' : 'warn',
      event: 'http.permission.answered',
      runId: decision.runId,
      requestId: decision.requestId,
      decision: decision.decision,
      answered: answered === true,
    });
    if (answered !== true) {
      sendJson(response, 409, {
        error:
          `No pending permission ${decision.requestId} on run ${decision.runId}. It was already ` +
          'answered, the run ended, or the id is wrong.',
      });
      return;
    }
    sendJson(response, 200, { answered: true, ...decision });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const requestStarted = Date.now();
    const requestId = randomUUID();
    const runtimeSessionId = header(request, AGENTCORE_RUNTIME_SESSION_HEADER);
    const traceId = header(request, AWS_TRACE_HEADER);
    const context: LogContext = {
      ...(runOptions.logContext ?? {}),
      requestId,
      invocationId: requestId,
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
      ...(traceId === undefined ? {} : { traceId }),
      // The transport's best guess at session identity, so `http.request.*` and a
      // rejected payload carry it too. `invokeHeadless` may refine this to a
      // `payload.sessionId`, which is why the run's own records are the authority.
      ...(runtimeSessionId === undefined ? {} : { sessionId: runtimeSessionId }),
    };
    emitLog(runOptions.logSink, {
      ...context,
      event: 'http.request.started',
      method: request.method,
      path: url.pathname,
      query: safeSearchParameters(url),
      headers: safeRequestHeaders(request),
      remoteAddress: request.socket.remoteAddress,
      activeRuns,
    });
    let responseFinished = false;
    response.once('finish', () => {
      responseFinished = true;
      emitLog(runOptions.logSink, {
        ...context,
        event: 'http.request.completed',
        method: request.method,
        path: url.pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - requestStarted,
        activeRuns,
      });
    });
    response.once('close', () => {
      if (responseFinished) return;
      emitLog(runOptions.logSink, {
        ...context,
        level: 'warn',
        event: 'http.request.disconnected',
        method: request.method,
        path: url.pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - requestStarted,
        activeRuns,
      });
    });

    if (request.method === 'GET' && url.pathname === '/ping') {
      writePing(response);
      return;
    }
    const permissionRoute =
      request.method === 'POST' && url.pathname === '/invocations/permissions';
    if (request.method !== 'POST' || (url.pathname !== '/invocations' && !permissionRoute)) {
      rejected(runOptions.logSink, context, 404, 'Not found');
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (serviceKey !== undefined && header(request, 'x-agent-service-key') !== serviceKey) {
      rejected(runOptions.logSink, context, 401, 'Invalid agent service key');
      sendJson(response, 401, { error: 'Invalid agent service key' });
      return;
    }

    // The other half of `permissionFallback: 'ask'`: the run is suspended on a
    // `permission.requested` event it emitted to the stream, and this is the
    // request that answers it. Kept on the `/invocations` path because that is
    // what an AgentCore runtime routes.
    if (permissionRoute) {
      await answerPermission(request, response, context);
      return;
    }
    if (activeRuns >= maxConcurrentRuns) {
      rejected(runOptions.logSink, context, 429, 'Invocation capacity reached');
      sendJson(response, 429, {
        error: `At capacity: ${activeRuns} runs in flight of ${maxConcurrentRuns} allowed`,
      });
      return;
    }

    // A reconnect names the run it lost and where it got to. Checked before the
    // body is read, because a resuming caller has nothing new to say: the run it
    // is rejoining already has the payload that started it.
    const runId = header(request, RUN_ID_HEADER) ?? runtimeSessionId;
    const resuming = runId === undefined ? undefined : registry?.get(runId);
    if (resuming) {
      const after = lastEventId(request, url);
      emitLog(runOptions.logSink, {
        ...context,
        event: 'http.invocation.resumed',
        runId,
        afterSequence: after,
      });
      activeRuns += 1;
      setBusy(true);
      try {
        await writeEventStream(response, () => resuming.read(after), {
          keepAliveMs,
          ...(runId === undefined ? {} : { runId }),
          // Detaching, not ending: the run stays in the registry so the next
          // reconnect finds it, and its own idle window decides when it dies.
          release: async () => undefined,
        });
      } finally {
        activeRuns -= 1;
        setBusy(activeRuns > 0);
      }
      return;
    }
    if (header(request, 'last-event-id') !== undefined && registry) {
      rejected(runOptions.logSink, context, 409, 'No resumable run for that id');
      sendJson(response, 409, {
        error:
          `No run is being held for ${runId ?? '(no run id)'}. It finished and was released, ` +
          'or its resume window passed. Start a new run.',
      });
      return;
    }

    let payload: unknown;
    try {
      payload = await readJson(request, maxBodyBytes);
    } catch (error) {
      rejected(runOptions.logSink, context, 400, describe(error));
      sendJson(response, 400, { error: describe(error) });
      return;
    }

    // The transport decides streaming, and only falls back to the payload when it
    // said nothing: the same configuration is legitimately run both ways, and a body
    // must not be able to contradict the `Accept` its caller sent — that header is
    // what the caller can actually read. `payload.stream` exists so a stored agent
    // definition can carry the preference for a caller that sends `Accept: */*`.
    const accept = header(request, 'accept') ?? '';
    const requested = url.searchParams.get('stream');
    const streaming =
      requested === 'true' || accept.includes('text/event-stream')
        ? true
        : requested === 'false' || accept.includes('application/json')
          ? false
          : payloadPrefersStream(payload);

    activeRuns += 1;
    setBusy(true);
    const invocationOptions: HeadlessRunOptions = {
      ...runOptions,
      invocationId: requestId,
      logContext: context,
      // Every invocation AgentCore routes to one session carries the same header, so
      // handing it down is what makes their logs share a `sessionId` — and, when a
      // `sessionStore` is configured, what lets them share a conversation.
      ...(runtimeSessionId === undefined ? {} : { sessionId: runtimeSessionId }),
      // Only a registered stream can be asked a question and answer it: the
      // request that decides arrives after the one that asked, and needs the
      // session to still be findable.
      ...(registry && streaming ? { interactivePermissions: true } : {}),
    };
    try {
      if (streaming) {
        if (registry) {
          const id = runId ?? requestId;
          const record = registry.start(id, (setSession) =>
            streamHeadless(payload, { ...invocationOptions, onSession: setSession }),
          );
          await writeEventStream(response, () => record.read(0), {
            keepAliveMs,
            runId: id,
            release: async () => undefined,
          });
          return;
        }
        await writeEventStream(response, () => streamHeadless(payload, invocationOptions), {
          keepAliveMs,
        });
        return;
      }
      // A failure inside the turn comes back as `status: 'error'` on a 200, because
      // the result still carries the partial output and the tokens it spent. Only a
      // payload this runner could not act on is a 4xx.
      sendJson(response, 200, await invokeHeadless(payload, invocationOptions));
    } catch (error) {
      emitLog(runOptions.logSink, {
        ...context,
        level: 'error',
        event: 'http.invocation.failed',
        streaming,
        statusCode: statusForError(error),
        durationMs: Date.now() - requestStarted,
        error: errorDetails(error),
      });
      if (!response.headersSent) {
        sendJson(response, statusForError(error), { error: describe(error) });
      }
      response.end();
    } finally {
      activeRuns -= 1;
      setBusy(activeRuns > 0);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? HEADLESS_PORT, options.host ?? HEADLESS_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new AgentHarnessError('Headless server did not bind', 'SERVER_NOT_BOUND');
  }
  const serverUrl = `http://${options.host ?? HEADLESS_HOST}:${address.port}`;
  emitLog(runOptions.logSink, {
    ...(runOptions.logContext ?? {}),
    event: 'server.started',
    url: serverUrl,
    maxBodyBytes,
    maxConcurrentRuns,
    authenticated: serviceKey !== undefined,
  });
  if (serviceKey === undefined) {
    const message =
      'headless: no serviceKey set, so /invocations is unauthenticated. A payload chooses the ' +
      'system prompt, the model endpoint, the MCP servers, and the permission mode, so anyone ' +
      'who can reach this port can run commands here. Set AGENT_SERVICE_KEY, or bind to ' +
      'loopback behind a front door that authenticates.';
    emitLog(runOptions.logSink, {
      ...(runOptions.logContext ?? {}),
      level: 'warn',
      event: 'server.security.warning',
      message,
    });
    if (runOptions.logSink === undefined) process.stderr.write(`${message}\n`);
  }
  return {
    server,
    url: serverUrl,
    close: async () => {
      const started = Date.now();
      emitLog(runOptions.logSink, {
        ...(runOptions.logContext ?? {}),
        event: 'server.shutdown.started',
        activeRuns,
      });
      // Held runs first: each one may own MCP processes and a skill directory,
      // and closing the listener does not reach either.
      await registry?.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      emitLog(runOptions.logSink, {
        ...(runOptions.logContext ?? {}),
        event: 'server.shutdown.completed',
        durationMs: Date.now() - started,
      });
    },
  };
}

/**
 * Read from the unvalidated body, because the encoding has to be chosen before a
 * response starts. Only a literal `true` counts: any other value falls through to
 * buffered and is then rejected by the schema with a 400, rather than being guessed
 * at here.
 */
function payloadPrefersStream(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { stream?: unknown }).stream === true
  );
}

/**
 * Advances the generator once before writing SSE headers, so a payload rejected at
 * validation still gets a status code. Once the headers are out they cannot be taken
 * back, and a later failure has to travel as an event instead.
 *
 * `release` decides what a finished or abandoned stream does to the run behind it.
 * Without a registry that is "end it", which is the stateless default; with one the
 * run outlives the socket so a reconnect has something to resume.
 */
async function writeEventStream(
  response: ServerResponse,
  open: () => AsyncGenerator<AgentEvent>,
  options: { keepAliveMs: number; runId?: string; release?: () => Promise<void> },
): Promise<void> {
  const iterator = open();
  let first: IteratorResult<AgentEvent>;
  try {
    first = await iterator.next();
  } catch (error) {
    sendJson(response, statusForError(error), { error: describe(error) });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Reverse proxies that buffer by default hold a stream until it ends, which
    // turns every delta into one delivery at the finish.
    'x-accel-buffering': 'no',
    ...(options.runId === undefined ? {} : { 'x-run-id': options.runId }),
  });

  // A comment frame is a no-op to an SSE reader and traffic to everything in
  // between. Without it a turn that spends four minutes in one tool looks to an
  // idle-timeout proxy exactly like a dead connection.
  const keepAlive = setInterval(() => {
    if (responseIsClosed(response)) return;
    try {
      response.write(': keep-alive\n\n');
    } catch {
      // A disconnect can race the check above. The request loop observes the
      // closed response and reaches its cleanup path on its next turn.
    }
  }, options.keepAliveMs);
  keepAlive.unref?.();

  try {
    for (let next = first; next.done !== true; next = await iterator.next()) {
      if (responseIsClosed(response)) break;
      await writeFrame(
        response,
        `id: ${next.value.sequence}\nevent: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`,
      );
    }
  } catch (error) {
    if (!responseIsClosed(response)) {
      await writeFrame(
        response,
        `event: error\ndata: ${JSON.stringify({ error: describe(error) })}\n\n`,
      ).catch(() => undefined);
    }
  } finally {
    clearInterval(keepAlive);
    if (options.release) {
      await options.release();
    } else {
      // Reaches the generator's `finally`, which closes the MCP connections and
      // deletes the skill directory. Without it, a caller that hung up mid-stream
      // would leave stdio servers running.
      await iterator.return(undefined as never).catch(() => undefined);
    }
  }
  if (!responseIsClosed(response)) response.end();
}

/**
 * Writes one frame, waiting for `drain` when the socket is full.
 *
 * Ignoring the return of `write` is how a fast model and a slow reader turn into
 * unbounded memory in this process: Node keeps accepting writes and queues every
 * one of them.
 */
async function writeFrame(response: ServerResponse, frame: string): Promise<void> {
  if (responseIsClosed(response)) return;

  let accepted: boolean;
  try {
    accepted = response.write(frame);
  } catch (error) {
    if (responseIsClosed(response)) return;
    throw error;
  }
  if (accepted || responseIsClosed(response)) return;

  await new Promise<void>((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      response.off('error', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
    response.once('error', done);

    // `close` may have fired after write() returned false but before the
    // listeners above were attached. Rechecking avoids waiting for an event
    // that has already happened and guarantees the generator's cleanup runs.
    if (responseIsClosed(response)) done();
  });
}

function responseIsClosed(response: ServerResponse): boolean {
  return response.writableEnded || response.destroyed || response.closed;
}

/**
 * A payload the runner refused is the caller's to fix, so it is a 400. Everything
 * else — an unreachable MCP server, a model endpoint that will not answer — is
 * reported as a 502, because the request was well formed and something the payload
 * named did not respond.
 */
function statusForError(error: unknown): number {
  if (!(error instanceof AgentHarnessError)) return 500;
  const clientErrors = new Set([
    'HEADLESS_PAYLOAD_INVALID',
    'AGENT_TOOL_NOT_AVAILABLE',
    'UNSUPPORTED_AGENT_TOOL',
    'AGENT_LIMIT_EXCEEDS_MODEL',
    'MODEL_PROVIDER_BASE_URL_MISSING',
    'MODEL_BASE_URL_INVALID',
    'MISSING_MODEL_CREDENTIAL',
    'SKILL_TOOL_NOT_AVAILABLE',
    'S3_URI_INVALID',
    'UNSUPPORTED_PROVIDER',
    'UNSUPPORTED_AUTH_KIND',
    'UNSUPPORTED_MCP_TRANSPORT',
  ]);
  return clientErrors.has(error.code) ? 400 : 502;
}

function permissionDecision(
  body: unknown,
): { runId: string; requestId: string; decision: 'allow' | 'deny' } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = body as Record<string, unknown>;
  const { runId, requestId, decision } = value;
  if (typeof runId !== 'string' || !runId) return undefined;
  if (typeof requestId !== 'string' || !requestId) return undefined;
  if (decision !== 'allow' && decision !== 'deny') return undefined;
  return { runId, requestId, decision };
}

/**
 * Where a reconnect got to. `Last-Event-ID` is the SSE-native spelling and what a
 * browser resends by itself; the query parameter is for callers that cannot set
 * headers. `0` means "from the beginning", which is also what a malformed value
 * falls back to — replaying is recoverable, skipping silently is not.
 */
function lastEventId(request: IncomingMessage, url: URL): number {
  const raw = header(request, 'last-event-id') ?? url.searchParams.get('lastEventId') ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() ? single.trim() : undefined;
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > maximumBytes) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('Request body is required');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejected(
  logSink: LogSink | undefined,
  context: LogContext,
  statusCode: number,
  reason: string,
): void {
  emitLog(logSink, {
    ...context,
    level: statusCode >= 500 ? 'error' : 'warn',
    event: 'http.request.rejected',
    statusCode,
    reason,
  });
}

function safeRequestHeaders(request: IncomingMessage): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      if (isSensitiveName(name)) return [[name, '[REDACTED]']];
      return [[name, value]];
    }),
  );
}

function safeSearchParameters(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of url.searchParams) {
    const safeValue = isSensitiveName(name) ? '[REDACTED]' : value;
    const existing = result[name];
    result[name] =
      existing === undefined
        ? safeValue
        : Array.isArray(existing)
          ? [...existing, safeValue]
          : [existing, safeValue];
  }
  return result;
}

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return (
    /(^|[-_])(api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|service[-_]?key|token)([-_]|$)/.test(
      normalized,
    ) || normalized === 'set-cookie'
  );
}

function errorDetails(error: unknown): {
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AgentEvent } from '../../core/events.js';
import { AgentHarnessError } from '../../core/errors.js';
import type { GatewaySession, SessionGateway } from '../../gateway/session-gateway.js';

/**
 * The header AgentCore Runtime forwards with the session identifier the caller
 * passed as `runtimeSessionId`. Requests carrying the same value reach the same
 * microVM, which is what lets this adapter hold sessions in memory.
 */
export const AGENTCORE_SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/**
 * Set by a caller invoking on behalf of one of its own end users. Optional, and
 * requires `bedrock-agentcore:InvokeAgentRuntimeForUser` on the caller's side.
 */
export const AGENTCORE_USER_HEADER = 'x-amzn-bedrock-agentcore-runtime-user-id';

/** Port and host are fixed by the runtime contract, not by preference. */
export const AGENTCORE_PORT = 8080;
export const AGENTCORE_HOST = '0.0.0.0';

const identifier = z.string().min(1).max(200);

/**
 * What one `POST /invocations` body may say.
 *
 * AgentCore gives a container exactly one invocation path, while a session here
 * has more to it than sending a prompt: a run streams, a permission request is
 * answered out of band, and a dropped stream is resumed by sequence. Those are
 * the eight endpoints `gateway-server.ts` exposes over HTTP, so the operation
 * moves into the body and this is the discriminator for it.
 *
 * `strict` on every branch: an unrecognised field in an invocation is a caller
 * that believes it asked for something. Silently dropping it would run the
 * prompt without whatever the field was meant to change.
 */
export const agentCoreInvocationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run'),
      prompt: z.string().min(1).max(5_000_000),
      /**
       * `agents.name`. Unset uses the record marked `isDefault`. Honoured only
       * on the invocation that opens the session, because the prompt, tools, and
       * skills of a session are the agent's: switching it mid-conversation would
       * leave earlier turns in the transcript that the new agent never had.
       */
      agentName: z.string().min(1).max(100).optional(),
      /**
       * Repeating a `runId` replays that run's events instead of running again,
       * so a caller that lost the response to a timeout can ask for it without
       * spending the turns a second time.
       */
      runId: identifier.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('permission'),
      requestId: identifier,
      decision: z.enum(['allow', 'deny']),
    })
    .strict(),
  z.object({ type: z.literal('interrupt'), reason: z.string().max(1_000).optional() }).strict(),
  z.object({ type: z.literal('replay'), after: z.number().int().min(0).optional() }).strict(),
  z.object({ type: z.literal('close') }).strict(),
]);

export type AgentCoreInvocation = z.infer<typeof agentCoreInvocationSchema>;

export type AgentCoreRuntimeServerOptions = {
  gateway: SessionGateway;
  /** Overridden only by tests; the contract fixes both in a deployed container. */
  host?: string;
  port?: number;
  /** Defaults to 1 MB, matching `gateway-server.ts`. Prompts are the only large field. */
  maxBodyBytes?: number;
};

export type RunningAgentCoreRuntimeServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

type Binding = {
  session: GatewaySession;
  agentName: string | undefined;
};

/**
 * Serves the AgentCore Runtime HTTP contract: `POST /invocations` and `GET /ping`
 * on port 8080.
 *
 * This is a second adapter over `SessionGateway`, not a replacement for
 * `gateway-server.ts`. The gateway server stays the surface for a deployment that
 * owns its own load balancer and can expose eight paths; this one exists because
 * AgentCore routes every request through one.
 *
 * Sessions are held in memory, keyed by the caller's `runtimeSessionId`. That is
 * sound here for a reason particular to this host: AgentCore pins a session id to
 * one microVM, so the caller that created a session is the only one that can
 * reach it and it is always the same process answering. The same assumption
 * behind a load balancer would need sticky routing to hold.
 */
export async function startAgentCoreRuntimeServer(
  options: AgentCoreRuntimeServerOptions,
): Promise<RunningAgentCoreRuntimeServer> {
  const bindings = new Map<string, Binding>();
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  let activeRuns = 0;
  // Tracked so `/ping` can report the status change without restating it on every
  // probe. See `writePing` for why that distinction matters.
  let busy = false;
  let statusChangedAtSeconds = Math.floor(Date.now() / 1000);

  const setBusy = (next: boolean): void => {
    if (next === busy) return;
    busy = next;
    statusChangedAtSeconds = Math.floor(Date.now() / 1000);
  };

  const bind = async (
    runtimeSessionId: string,
    ownerId: string,
    agentName: string | undefined,
  ): Promise<Binding> => {
    const existing = bindings.get(runtimeSessionId);
    if (existing) return existing;
    const session = await options.gateway.create(ownerId, agentName);
    const binding: Binding = { session, agentName };
    bindings.set(runtimeSessionId, binding);
    return binding;
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // Last resort: the handler already answers its own failures, so reaching
      // here means the response itself broke. AgentCore reports a container error
      // as 424 to the caller and the detail only survives in CloudWatch.
      process.stderr.write(`agentcore: unhandled request failure: ${describe(error)}\n`);
      if (!response.headersSent) sendJson(response, 500, { error: describe(error) });
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/ping') {
      writePing(response);
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/invocations') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const runtimeSessionId = header(request, AGENTCORE_SESSION_HEADER);
    if (!runtimeSessionId) {
      sendJson(response, 400, {
        error: `${AGENTCORE_SESSION_HEADER} is required: it identifies the session to run in`,
      });
      return;
    }
    // The caller's own end-user id when it passed one, and the session otherwise.
    // Never a value from the body: `SessionGateway.canView` authorizes artifact
    // and event reads against it, so a payload field would let one caller name
    // another as owner.
    const ownerId = header(request, AGENTCORE_USER_HEADER) ?? runtimeSessionId;

    let invocation: AgentCoreInvocation;
    try {
      invocation = agentCoreInvocationSchema.parse(
        normalizeInvocation(await readJson(request, maxBodyBytes)),
      );
    } catch (error) {
      sendJson(response, 400, { error: describe(error) });
      return;
    }

    try {
      await dispatch(invocation, runtimeSessionId, ownerId, response);
    } catch (error) {
      // Expected failures reach here: a control operation naming a session that
      // was closed, a disabled agent record, a rejected control token. They are
      // answered with a status rather than logged as a crash, because a run that
      // already streamed cannot be answered at all and only that case is a bug.
      sendJson(response, statusForError(error), { error: describe(error) });
      response.end();
    }
  }

  async function dispatch(
    invocation: AgentCoreInvocation,
    runtimeSessionId: string,
    ownerId: string,
    response: ServerResponse,
  ): Promise<void> {
    switch (invocation.type) {
      case 'run': {
        const binding = await bind(runtimeSessionId, ownerId, invocation.agentName);
        if (invocation.agentName !== undefined && invocation.agentName !== binding.agentName) {
          sendJson(response, 409, {
            error:
              `Session is already running agent '${binding.agentName ?? 'default'}'. An agent is ` +
              "chosen when the session opens, because the transcript so far is that agent's. " +
              'Use a new runtimeSessionId to run a different one.',
          });
          return;
        }
        activeRuns += 1;
        setBusy(true);
        try {
          await streamEvents(response, () =>
            options.gateway.streamRun(
              binding.session.sessionId,
              binding.session.controlToken,
              invocation.prompt,
              invocation.runId,
            ),
          );
        } finally {
          activeRuns -= 1;
          setBusy(activeRuns > 0);
        }
        return;
      }
      case 'permission': {
        const binding = requireBinding(bindings, runtimeSessionId);
        const resolved = options.gateway.respondToPermission(
          binding.session.sessionId,
          binding.session.controlToken,
          invocation.requestId,
          invocation.decision,
        );
        sendJson(response, resolved ? 200 : 404, { resolved });
        return;
      }
      case 'interrupt': {
        const binding = requireBinding(bindings, runtimeSessionId);
        options.gateway.interrupt(
          binding.session.sessionId,
          binding.session.controlToken,
          invocation.reason ?? 'agentcore interrupt',
        );
        sendJson(response, 200, { interrupted: true });
        return;
      }
      case 'replay': {
        const binding = requireBinding(bindings, runtimeSessionId);
        if (!options.gateway.canView(binding.session.sessionId, ownerId)) {
          sendJson(response, 403, { error: 'Session view denied' });
          return;
        }
        sendJson(response, 200, {
          events: options.gateway.replay(binding.session.sessionId, invocation.after ?? 0),
        });
        return;
      }
      case 'close': {
        const binding = bindings.get(runtimeSessionId);
        bindings.delete(runtimeSessionId);
        if (binding) {
          await options.gateway.close(binding.session.sessionId, binding.session.controlToken);
        }
        sendJson(response, 200, { closed: true });
        return;
      }
    }
  }

  /**
   * Reports `HealthyBusy` while a run is in flight, which keeps the session alive
   * through a long turn instead of letting the idle timeout reclaim it.
   *
   * `time_of_last_update` is sent only when the status actually changed. A
   * timestamp that advanced on every probe would read as a status that never
   * settles, and the idle timeout would then never fire: sessions would live to
   * `MaxLifetime` and consume the session quota until they did.
   */
  function writePing(response: ServerResponse): void {
    sendJson(response, 200, {
      status: busy ? 'HealthyBusy' : 'Healthy',
      time_of_last_update: statusChangedAtSeconds,
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? AGENTCORE_PORT, options.host ?? AGENTCORE_HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new AgentHarnessError('AgentCore server did not bind', 'SERVER_NOT_BOUND');
  }
  return {
    server,
    url: `http://${options.host ?? AGENTCORE_HOST}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Streams events as SSE, but only commits to a 200 once the first one arrives.
 *
 * The order matters: a run that fails before it starts — an unknown session, a
 * rejected control token — should answer with a status the caller can act on, and
 * SSE headers cannot be taken back once written. So the iterator is advanced
 * once first, and only a failure after that point is reported inside the stream.
 */
async function streamEvents(
  response: ServerResponse,
  open: () => AsyncIterable<AgentEvent>,
): Promise<void> {
  const iterator = open()[Symbol.asyncIterator]();
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
  });
  try {
    for (let next = first; next.done !== true; next = await iterator.next()) {
      response.write(frame(next.value));
    }
  } catch (error) {
    // Past the headers, so the failure has to travel as an event. `replay` picks
    // up from the last sequence the caller saw.
    response.write(`event: error\ndata: ${JSON.stringify({ error: describe(error) })}\n\n`);
  }
  response.end();
}

function frame(event: AgentEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Accepts the plain `{ "prompt": ... }` body from the AgentCore documentation by
 * reading it as a run. A caller that has only ever sent a prompt should not have
 * to learn this adapter's discriminator to keep working.
 */
export function normalizeInvocation(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && !('type' in value)) {
    return { ...(value as Record<string, unknown>), type: 'run' };
  }
  return value;
}

function requireBinding(bindings: Map<string, Binding>, runtimeSessionId: string): Binding {
  const binding = bindings.get(runtimeSessionId);
  if (!binding) {
    throw new AgentHarnessError(
      `No open session for runtimeSessionId ${runtimeSessionId}. Send a run first; a control ` +
        'operation cannot open one, because it carries no agent to open it with.',
      'SESSION_NOT_FOUND',
    );
  }
  return binding;
}

function statusForError(error: unknown): number {
  if (error instanceof AgentHarnessError) {
    if (error.code === 'SESSION_NOT_FOUND' || error.code === 'AGENT_NOT_FOUND') return 404;
    if (error.code === 'AGENT_DISABLED') return 409;
  }
  const message = describe(error);
  if (/control denied/i.test(message)) return 403;
  if (/^Unknown session/i.test(message)) return 404;
  return 500;
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

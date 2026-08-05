import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENTCORE_SESSION_HEADER,
  AGENTCORE_USER_HEADER,
  createAgentSession,
  normalizeInvocation,
  RulePermissionHandler,
  ScriptedModelProvider,
  scrubbedEnvironment,
  SessionGateway,
  startAgentCoreRuntimeServer,
  type AgentEvent,
} from '../../src/index.js';

/** A session whose provider answers once with text and stops. */
function textGateway(onRequest?: (agentName: string | undefined) => void): SessionGateway {
  return new SessionGateway({
    createSession: (request) => {
      onRequest?.(request.agentName);
      return createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'answered' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
        permissionHandler: new RulePermissionHandler({ fallback: 'deny' }),
      });
    },
  });
}

async function invoke(
  url: string,
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/invocations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [AGENTCORE_SESSION_HEADER]: sessionId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Collects the `data:` payloads out of an SSE body. */
async function readEvents(response: Response): Promise<AgentEvent[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as AgentEvent);
}

test('ping reports Healthy and holds its timestamp steady between status changes', async () => {
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const first = (await (await fetch(`${running.url}/ping`)).json()) as Record<string, unknown>;
    assert.equal(first.status, 'Healthy');
    assert.equal(typeof first.time_of_last_update, 'number');

    // A timestamp that advanced on every probe would read as a status that never
    // settles, and the idle timeout would never fire.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = (await (await fetch(`${running.url}/ping`)).json()) as Record<string, unknown>;
    assert.equal(second.time_of_last_update, first.time_of_last_update);
  } finally {
    await running.close();
  }
});

test('a run streams SSE and binds the session to the runtimeSessionId', async () => {
  const requested: Array<string | undefined> = [];
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway((agentName) => requested.push(agentName)),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const response = await invoke(running.url, 'session-alpha', {
      type: 'run',
      prompt: 'first',
      agentName: 'triage',
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = await readEvents(response);
    assert.equal(events.at(0)?.type, 'session.started');
    assert.ok(events.some((event) => event.type === 'assistant.text.delta'));

    // Second run, same runtimeSessionId: the session is reused rather than rebuilt,
    // so the factory is not asked for another agent.
    await readEvents(await invoke(running.url, 'session-alpha', { type: 'run', prompt: 'second' }));
    assert.deepEqual(requested, ['triage']);

    // A different runtimeSessionId is a different session.
    await readEvents(await invoke(running.url, 'session-beta', { type: 'run', prompt: 'other' }));
    assert.deepEqual(requested, ['triage', undefined]);
  } finally {
    await running.close();
  }
});

test('replay returns buffered events and a repeated runId does not run twice', async () => {
  let sessions = 0;
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(() => {
      sessions += 1;
    }),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const first = await readEvents(
      await invoke(running.url, 'session-replay', { type: 'run', prompt: 'work', runId: 'run-1' }),
    );
    const repeated = await readEvents(
      await invoke(running.url, 'session-replay', {
        type: 'run',
        prompt: 'ignored duplicate',
        runId: 'run-1',
      }),
    );
    assert.deepEqual(repeated, first);
    assert.equal(sessions, 1);

    const replay = await invoke(running.url, 'session-replay', { type: 'replay' });
    assert.equal(replay.status, 200);
    const body = (await replay.json()) as { events: AgentEvent[] };
    assert.deepEqual(body.events, first);

    const after = await invoke(running.url, 'session-replay', {
      type: 'replay',
      after: first.at(-1)?.sequence ?? 0,
    });
    assert.deepEqual(((await after.json()) as { events: AgentEvent[] }).events, []);
  } finally {
    await running.close();
  }
});

test('close releases the binding so a later control call reports no session', async () => {
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    await readEvents(await invoke(running.url, 'session-close', { type: 'run', prompt: 'work' }));
    const closed = await invoke(running.url, 'session-close', { type: 'close' });
    assert.equal(closed.status, 200);

    const orphan = await invoke(running.url, 'session-close', { type: 'interrupt' });
    assert.equal(orphan.status, 404);
    assert.match(String(((await orphan.json()) as { error: string }).error), /No open session/);
  } finally {
    await running.close();
  }
});

test('invalid invocations are refused before a session is opened', async () => {
  let sessions = 0;
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(() => {
      sessions += 1;
    }),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const unknownType = await invoke(running.url, 'session-bad', { type: 'explode' });
    assert.equal(unknownType.status, 400);

    // `strict` on every branch: an unrecognised field means the caller asked for
    // something this adapter would otherwise silently drop.
    const extraField = await invoke(running.url, 'session-bad', {
      type: 'run',
      prompt: 'hello',
      temperature: 0.5,
    });
    assert.equal(extraField.status, 400);

    const noHeader = await fetch(`${running.url}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'run', prompt: 'hello' }),
    });
    assert.equal(noHeader.status, 400);
    assert.match(
      String(((await noHeader.json()) as { error: string }).error),
      /runtime-session-id is required/i,
    );

    assert.equal(sessions, 0);
    assert.equal((await fetch(`${running.url}/unknown`)).status, 404);
  } finally {
    await running.close();
  }
});

test('switching agent on an open session is refused rather than silently ignored', async () => {
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    await readEvents(
      await invoke(running.url, 'session-switch', {
        type: 'run',
        prompt: 'work',
        agentName: 'triage',
      }),
    );
    const switched = await invoke(running.url, 'session-switch', {
      type: 'run',
      prompt: 'work',
      agentName: 'other',
    });
    assert.equal(switched.status, 409);
  } finally {
    await running.close();
  }
});

test('replay is denied to a caller that is not the session owner', async () => {
  const running = await startAgentCoreRuntimeServer({
    gateway: textGateway(),
    host: '127.0.0.1',
    port: 0,
  });
  try {
    await readEvents(
      await invoke(
        running.url,
        'session-owned',
        { type: 'run', prompt: 'work' },
        { [AGENTCORE_USER_HEADER]: 'app-one-user' },
      ),
    );
    const other = await invoke(
      running.url,
      'session-owned',
      { type: 'replay' },
      { [AGENTCORE_USER_HEADER]: 'app-two-user' },
    );
    assert.equal(other.status, 403);
  } finally {
    await running.close();
  }
});

test('a bare prompt body is read as a run', () => {
  assert.deepEqual(normalizeInvocation({ prompt: 'hello' }), { prompt: 'hello', type: 'run' });
  // An explicit type is never rewritten.
  assert.deepEqual(normalizeInvocation({ type: 'close' }), { type: 'close' });
  assert.deepEqual(normalizeInvocation('not an object'), 'not an object');
});

test('scrubbedEnvironment keeps the allowlist and drops platform secrets', () => {
  const scrubbed = scrubbedEnvironment(
    {
      PATH: '/usr/bin',
      PLATFORM_MONGODB_URI: 'mongodb://user:password@host/db',
      AWS_SECRET_ACCESS_KEY: 'secret',
      OPENROUTER_API_KEY: 'secret',
      HTTPS_PROXY: 'http://proxy',
    },
    ['HTTPS_PROXY'],
  );
  assert.deepEqual(scrubbed, { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy' });
  // Absent names stay absent rather than becoming an empty string a script would
  // read as configured.
  assert.equal('HOME' in scrubbed, false);
});

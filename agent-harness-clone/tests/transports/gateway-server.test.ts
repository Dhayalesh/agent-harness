import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  createAgentSession,
  InMemoryArtifactStore,
  ScriptedModelProvider,
  SessionGateway,
  startGatewayServer,
  type Tool,
} from '../../src/index.js';

type ReadChunk = { done: boolean; value?: Uint8Array };

test('authenticated gateway creates, streams, and replays a controlled session', async () => {
  const gateway = new SessionGateway({
    createSession: () =>
      createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'gateway answer' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
      }),
  });
  const artifacts = new InMemoryArtifactStore();
  const server = await startGatewayServer({
    gateway,
    artifactStore: artifacts,
    authenticate(request) {
      assert.equal(request.headers['x-test-auth'], 'yes');
      return 'test-owner';
    },
  });
  try {
    const createdResponse = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'x-test-auth': 'yes' },
    });
    const created = (await createdResponse.json()) as {
      sessionId: string;
      controlToken: string;
    };
    const runResponse = await fetch(`${server.url}/sessions/${created.sessionId}/runs`, {
      method: 'POST',
      headers: {
        'x-test-auth': 'yes',
        authorization: `Bearer ${created.controlToken}`,
      },
      body: JSON.stringify({ prompt: 'work', runId: 'run-1' }),
    });
    assert.match(await runResponse.text(), /gateway answer/);
    const replay = await fetch(`${server.url}/sessions/${created.sessionId}/events`, {
      headers: { 'x-test-auth': 'yes' },
    });
    const events = (await replay.json()) as unknown[];
    assert.ok(events.length > 0);

    const upload = await fetch(`${server.url}/sessions/${created.sessionId}/artifacts`, {
      method: 'POST',
      headers: {
        'x-test-auth': 'yes',
        authorization: `Bearer ${created.controlToken}`,
      },
      body: JSON.stringify({
        content: 'attachment contents',
        contentType: 'text/plain',
      }),
    });
    assert.equal(upload.status, 201);
    const artifact = (await upload.json()) as { id: string };
    const download = await fetch(`${server.url}/artifacts/${artifact.id}`, {
      headers: { 'x-test-auth': 'yes' },
    });
    assert.equal(await download.text(), 'attachment contents');
  } finally {
    await server.close();
  }
});

test('gateway routes asynchronous permission responses to an active run', async () => {
  let executed = false;
  const schema = z.object({});
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'remote_mutation',
    description: 'Remote mutation',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'write',
    concurrencySafe: false,
    async execute() {
      executed = true;
      return { content: 'mutated' };
    },
  };
  const gateway = new SessionGateway({
    createSession: () =>
      createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'tool_call', id: 'mutation', name: 'remote_mutation', input: {} },
            { type: 'completed', stopReason: 'tool_use' },
          ],
          [
            { type: 'text_delta', delta: 'permission handled' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
        tools: [tool],
      }),
  });
  const server = await startGatewayServer({
    gateway,
    authenticate: () => 'owner',
  });
  try {
    const created = (await (await fetch(`${server.url}/sessions`, { method: 'POST' })).json()) as {
      sessionId: string;
      controlToken: string;
    };
    const response = await fetch(`${server.url}/sessions/${created.sessionId}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.controlToken}` },
      body: JSON.stringify({ prompt: 'mutate' }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let body = '';
    let requestId: string | undefined;
    while (!requestId) {
      const chunk = (await reader.read()) as ReadChunk;
      assert.equal(chunk.done, false);
      if (chunk.value) body += decoder.decode(chunk.value, { stream: true });
      requestId = body.match(/"requestId":"([^"]+)"/)?.[1];
    }
    const permission = await fetch(
      `${server.url}/sessions/${created.sessionId}/permissions/${requestId}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${created.controlToken}` },
        body: JSON.stringify({ decision: 'allow' }),
      },
    );
    assert.equal(permission.status, 200);
    while (true) {
      const chunk = (await reader.read()) as ReadChunk;
      if (chunk.done) break;
      if (chunk.value) body += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(executed, true);
    assert.match(body, /permission handled/);
  } finally {
    await server.close();
  }
});

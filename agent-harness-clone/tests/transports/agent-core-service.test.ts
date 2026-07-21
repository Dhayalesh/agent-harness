import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentCoreDemoProvider,
  startAgentCoreService,
  type AgentEvent,
} from '../../src/index.js';

test('standalone agent-core service completes an approved API tool trajectory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-core-service-'));
  const workspace = path.join(root, 'workspace');
  const service = await startAgentCoreService({
    workspace,
    dataDirectory: path.join(root, 'data'),
    createProvider: createAgentCoreDemoProvider,
    serviceKey: 'test-service-key',
  });
  const headers = {
    'x-agent-owner': 'test-owner',
    'x-agent-service-key': 'test-service-key',
  };
  try {
    const health = await fetch(`${service.url}/health`);
    assert.deepEqual(await health.json(), { status: 'ok', protocolVersion: 1 });

    const created = (await requestJson(`${service.url}/sessions`, {
      method: 'POST',
      headers,
    })) as { sessionId: string; controlToken: string };
    const run = await fetch(`${service.url}/sessions/${created.sessionId}/runs`, {
      method: 'POST',
      headers: {
        ...headers,
        authorization: `Bearer ${created.controlToken}`,
      },
      body: JSON.stringify({ prompt: 'service integration', runId: 'demo-run' }),
    });
    assert.ok(run.body);
    const events: AgentEvent[] = [];
    for await (const event of readSseEvents(run.body)) {
      events.push(event);
      if (event.type === 'permission.requested') {
        const permission = await requestJson(
          `${service.url}/sessions/${created.sessionId}/permissions/${event.requestId}`,
          {
            method: 'POST',
            headers: {
              ...headers,
              authorization: `Bearer ${created.controlToken}`,
            },
            body: JSON.stringify({ decision: 'allow' }),
          },
        );
        assert.deepEqual(permission, { resolved: true });
      }
    }
    assert.ok(events.some((event) => event.type === 'permission.requested'));
    assert.ok(events.some((event) => event.type === 'tool.completed' && !event.result.isError));
    assert.ok(events.some((event) => event.type === 'session.completed'));
    assert.match(
      await readFile(path.join(workspace, '.agent-core-demo.txt'), 'utf8'),
      /service integration/,
    );

    const replay = (await requestJson(
      `${service.url}/sessions/${created.sessionId}/events?after=0`,
      { headers },
    )) as AgentEvent[];
    assert.equal(replay.length, events.length);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) assert.fail(`Request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncIterable<AgentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      if (data) yield JSON.parse(data) as AgentEvent;
    }
    if (done) return;
  }
}

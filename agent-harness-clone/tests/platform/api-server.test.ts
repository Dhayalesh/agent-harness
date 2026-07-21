import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  AgentExecutionPlatform,
  AgentPlatformControlPlane,
  AgentPlatformSessionManager,
  InMemoryPlatformRuntimeStore,
  InMemoryPlatformSecretResolver,
  InMemoryPlatformStore,
  LocalRuntimeHost,
  ScriptedModelProvider,
  startAgentPlatformServer,
  TrustedDataSourceCatalog,
  TrustedToolCatalog,
  type AgentDefinition,
  type AgentEvent,
  type PlatformPrincipal,
  type Tool,
} from '../../src/index.js';

const principal: PlatformPrincipal = {
  tenantId: 'api-tenant',
  userId: 'api-admin',
  roles: ['admin'],
};

type ReadChunk = { done: boolean; value?: Uint8Array };

test('platform API manages a versioned agent and executes it without a frontend', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-platform-api-'));
  const controlPlane = new AgentPlatformControlPlane(new InMemoryPlatformStore());
  const execution = new AgentExecutionPlatform({
    controlPlane,
    models: {
      async resolve() {
        return new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'platform API result' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]);
      },
    },
    tools: new TrustedToolCatalog(),
    dataSources: new TrustedDataSourceCatalog(),
    secrets: new InMemoryPlatformSecretResolver({}),
    createRuntime: () => new LocalRuntimeHost(root),
  });
  const sessions = new AgentPlatformSessionManager(execution, new InMemoryPlatformRuntimeStore());
  await Promise.all([controlPlane.initialize(), sessions.initialize()]);
  const server = await startAgentPlatformServer({
    controlPlane,
    sessions,
    authenticate(request) {
      assert.equal(request.headers.authorization, 'Bearer platform-test-key');
      return principal;
    },
  });
  const headers = {
    authorization: 'Bearer platform-test-key',
    'content-type': 'application/json',
  };
  const definition: AgentDefinition = {
    systemPrompt: 'Run as a platform-managed agent.',
    model: { provider: 'openrouter', model: 'test/model', secretRef: 'MODEL_KEY' },
    tools: [],
    skills: [],
    dataSources: [],
    mcpServers: [],
    permissions: { mode: 'default', fallback: 'deny', rules: [] },
    limits: { maxTurns: 2 },
    metadata: {},
  };
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    const agent = (await json(`${server.url}/v1/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: 'api-agent', name: 'API Agent' }),
    })) as { id: string };
    const version = (await json(`${server.url}/v1/agents/${agent.id}/versions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ definition }),
    })) as { id: string; version: number };
    assert.equal(version.version, 1);
    await json(`${server.url}/v1/agents/${agent.id}/deployments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: version.id, environment: 'production' }),
    });
    const agents = (await json(`${server.url}/v1/agents`, { headers })) as Array<{ id: string }>;
    assert.deepEqual(
      agents.map((value) => value.id),
      [agent.id],
    );
    const versions = (await json(`${server.url}/v1/agents/${agent.id}/versions`, {
      headers,
    })) as Array<{ id: string }>;
    assert.equal(versions[0]?.id, version.id);
    const deployments = (await json(`${server.url}/v1/agents/${agent.id}/deployments`, {
      headers,
    })) as Array<{ versionId: string }>;
    assert.equal(deployments[0]?.versionId, version.id);
    const handle = (await json(`${server.url}/v1/agents/${agent.id}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ environment: 'production' }),
    })) as { sessionId: string; controlToken: string };
    const runHeaders = { ...headers, 'x-agent-control-token': handle.controlToken };
    const first = await fetch(`${server.url}/v1/sessions/${handle.sessionId}/runs`, {
      method: 'POST',
      headers: runHeaders,
      body: JSON.stringify({ prompt: 'execute', runId: 'api-run-1' }),
    });
    const firstEvents = parseSse(await first.text());
    assert.ok(firstEvents.some((event) => event.type === 'assistant.text.delta'));
    const listedSessions = (await json(`${server.url}/v1/sessions`, { headers })) as Array<
      Record<string, unknown>
    >;
    assert.equal(listedSessions[0]?.sessionId, handle.sessionId);
    assert.equal('controlTokenHash' in (listedSessions[0] ?? {}), false);
    const run = (await json(`${server.url}/v1/sessions/${handle.sessionId}/runs/api-run-1`, {
      headers,
    })) as { status: string };
    assert.equal(run.status, 'completed');

    const duplicate = await fetch(`${server.url}/v1/sessions/${handle.sessionId}/runs`, {
      method: 'POST',
      headers: runHeaders,
      body: JSON.stringify({ prompt: 'do not execute again', runId: 'api-run-1' }),
    });
    assert.deepEqual(parseSse(await duplicate.text()), firstEvents);
    const replay = (await json(`${server.url}/v1/sessions/${handle.sessionId}/events?after=0`, {
      headers,
    })) as AgentEvent[];
    assert.deepEqual(replay, firstEvents);
    await json(`${server.url}/v1/sessions/${handle.sessionId}`, {
      method: 'DELETE',
      headers: runHeaders,
    });
  } finally {
    await sessions.closeAll();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('platform API routes a remote permission decision into a paused run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-platform-permission-'));
  const controlPlane = new AgentPlatformControlPlane(new InMemoryPlatformStore());
  const tools = new TrustedToolCatalog();
  const schema = z.object({});
  let executed = false;
  tools.register('remote_mutation', '1', (): Tool<z.infer<typeof schema>> => ({
    name: 'remote_mutation',
    description: 'Mutate after remote approval',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'write',
    concurrencySafe: false,
    async execute() {
      executed = true;
      return { content: 'mutation complete' };
    },
  }));
  const execution = new AgentExecutionPlatform({
    controlPlane,
    models: {
      async resolve() {
        return new ScriptedModelProvider([
          [
            { type: 'tool_call', id: 'mutation', name: 'remote_mutation', input: {} },
            { type: 'completed', stopReason: 'tool_use' },
          ],
          [
            { type: 'text_delta', delta: 'approved through platform API' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]);
      },
    },
    tools,
    dataSources: new TrustedDataSourceCatalog(),
    secrets: new InMemoryPlatformSecretResolver({}),
    createRuntime: () => new LocalRuntimeHost(root),
  });
  const sessions = new AgentPlatformSessionManager(execution, new InMemoryPlatformRuntimeStore());
  await Promise.all([controlPlane.initialize(), sessions.initialize()]);
  const agent = await controlPlane.createAgent(principal, {
    slug: 'permission-agent',
    name: 'Permission Agent',
  });
  const version = await controlPlane.createVersion(principal, agent.id, {
    systemPrompt: 'Request permission.',
    model: { provider: 'openrouter', model: 'test/model', secretRef: 'MODEL_KEY' },
    tools: [{ name: 'remote_mutation', version: '1' }],
    skills: [],
    dataSources: [],
    mcpServers: [],
    permissions: { mode: 'default', fallback: 'ask', rules: [] },
    limits: { maxTurns: 3 },
    metadata: {},
  });
  await controlPlane.publish(principal, agent.id, version.id);
  const server = await startAgentPlatformServer({
    controlPlane,
    sessions,
    authenticate: () => principal,
  });
  const headers = { authorization: 'Bearer ignored', 'content-type': 'application/json' };
  try {
    const handle = (await json(`${server.url}/v1/agents/${agent.id}/sessions`, {
      method: 'POST',
      headers,
      body: '{}',
    })) as { sessionId: string; controlToken: string };
    const response = await fetch(`${server.url}/v1/sessions/${handle.sessionId}/runs`, {
      method: 'POST',
      headers: { ...headers, 'x-agent-control-token': handle.controlToken },
      body: JSON.stringify({ prompt: 'mutate', runId: 'permission-run' }),
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let body = '';
    let requestId: string | undefined;
    while (!requestId) {
      const chunk = (await reader.read()) as ReadChunk;
      assert.equal(chunk.done, false);
      body += decoder.decode(chunk.value, { stream: true });
      requestId = body.match(/"requestId":"([^"]+)"/)?.[1];
    }
    const permission = await json(
      `${server.url}/v1/sessions/${handle.sessionId}/permissions/${requestId}`,
      {
        method: 'POST',
        headers: { ...headers, 'x-agent-control-token': handle.controlToken },
        body: JSON.stringify({ decision: 'allow' }),
      },
    );
    assert.deepEqual(permission, { resolved: true });
    while (true) {
      const chunk = (await reader.read()) as ReadChunk;
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(executed, true);
    assert.match(body, /approved through platform API/);
  } finally {
    await sessions.closeAll();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) assert.fail(`Request failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function parseSse(value: string): AgentEvent[] {
  return value
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim(),
    )
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data) as AgentEvent);
}

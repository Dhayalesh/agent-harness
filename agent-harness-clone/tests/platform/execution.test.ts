import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  AgentExecutionPlatform,
  AgentPlatformControlPlane,
  InlineDataSourceConnector,
  InMemoryPlatformSecretResolver,
  InMemoryPlatformStore,
  LocalRuntimeHost,
  ScriptedModelProvider,
  TrustedDataSourceCatalog,
  TrustedToolCatalog,
  type AgentDefinition,
  type AgentEvent,
  type ModelRequest,
  type PlatformModelResolver,
  type PlatformPrincipal,
  type Tool,
} from '../../src/index.js';

const principal: PlatformPrincipal = {
  tenantId: 'tenant-execution',
  userId: 'platform-admin',
  roles: ['admin'],
};

test('deployed database definition resolves skills, data, tools, policy, and model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-platform-execution-'));
  const store = new InMemoryPlatformStore();
  const controlPlane = new AgentPlatformControlPlane(store);
  const tools = new TrustedToolCatalog();
  const dataSources = new TrustedDataSourceCatalog();
  dataSources.register(new InlineDataSourceConnector());
  const echoInput = z.object({ value: z.string() });
  tools.register('echo', '1', (): Tool<z.infer<typeof echoInput>> => ({
    name: 'echo',
    description: 'Echo a configured value',
    inputSchema: echoInput,
    jsonSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    kind: 'read',
    concurrencySafe: true,
    async execute({ value }) {
      return { content: value };
    },
  }));
  let firstRequest: ModelRequest | undefined;
  const models: PlatformModelResolver = {
    async resolve() {
      return new ScriptedModelProvider([
        (request) => {
          firstRequest = request;
          return [
            { type: 'tool_call', id: 'echo-call', name: 'echo', input: { value: 'resolved' } },
            { type: 'completed', stopReason: 'tool_use' },
          ];
        },
        [
          { type: 'text_delta', delta: 'Configured agent completed.' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]);
    },
  };
  const definition: AgentDefinition = {
    systemPrompt: 'Act from the stored definition.',
    model: { provider: 'openrouter', model: 'test/model', secretRef: 'MODEL_KEY' },
    tools: [{ name: 'echo', version: '1' }],
    skills: [
      {
        name: 'stored-skill',
        version: '3',
        description: 'Stored skill description',
        instructions: 'Apply the stored skill instructions.',
        allowedTools: ['echo'],
      },
    ],
    dataSources: [
      {
        name: 'knowledge',
        type: 'inline',
        version: '1',
        config: {
          documents: [
            { id: 'database-doc', text: 'MongoDB platform knowledge for the requested agent.' },
          ],
        },
      },
    ],
    mcpServers: [],
    permissions: { mode: 'default', fallback: 'deny', rules: [] },
    limits: { maxTurns: 4 },
    metadata: {},
  };
  try {
    const agent = await controlPlane.createAgent(principal, {
      slug: 'configured-agent',
      name: 'Configured Agent',
    });
    const version = await controlPlane.createVersion(principal, agent.id, definition);
    await controlPlane.publish(principal, agent.id, version.id);
    const execution = new AgentExecutionPlatform({
      controlPlane,
      models,
      tools,
      dataSources,
      secrets: new InMemoryPlatformSecretResolver({
        [principal.tenantId]: { MODEL_KEY: 'not-exposed' },
      }),
      createRuntime: () => new LocalRuntimeHost(root),
    });
    const session = await execution.createSession(principal, agent.slug);
    const events: AgentEvent[] = [];
    for await (const event of session.run({ prompt: 'Use MongoDB platform knowledge' })) {
      events.push(event);
    }
    await session.close();
    assert.ok(events.some((event) => event.type === 'tool.completed' && !event.result.isError));
    assert.ok(events.some((event) => event.type === 'assistant.text.delta'));
    assert.match(firstRequest?.systemPrompt ?? '', /Apply the stored skill instructions/);
    const requestText = firstRequest?.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    assert.match(requestText ?? '', /MongoDB platform knowledge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('execution fails closed for a tool version absent from the trusted catalog', async () => {
  const store = new InMemoryPlatformStore();
  const controlPlane = new AgentPlatformControlPlane(store);
  const agent = await controlPlane.createAgent(principal, {
    slug: 'untrusted-tool-agent',
    name: 'Untrusted Tool Agent',
  });
  const definition: AgentDefinition = {
    systemPrompt: 'Test trust.',
    model: { provider: 'openrouter', model: 'test/model', secretRef: 'MODEL_KEY' },
    tools: [{ name: 'unknown', version: '99' }],
    skills: [],
    dataSources: [],
    mcpServers: [],
    permissions: { mode: 'default', fallback: 'deny', rules: [] },
    limits: { maxTurns: 2 },
    metadata: {},
  };
  const version = await controlPlane.createVersion(principal, agent.id, definition);
  await controlPlane.publish(principal, agent.id, version.id);
  const execution = new AgentExecutionPlatform({
    controlPlane,
    models: {
      async resolve() {
        return new ScriptedModelProvider([]);
      },
    },
    tools: new TrustedToolCatalog(),
    dataSources: new TrustedDataSourceCatalog(),
    secrets: new InMemoryPlatformSecretResolver({}),
    createRuntime: () => new LocalRuntimeHost(process.cwd()),
  });
  await assert.rejects(execution.createSession(principal, agent.id), /Untrusted or unavailable/);
});

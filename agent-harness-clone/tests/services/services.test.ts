import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  InMemoryArtifactStore,
  InMemorySecretProvider,
  MetricsSink,
  NotificationSink,
  runDiagnostics,
  ScriptedModelProvider,
  SessionRateLimiter,
  checkForUpdate,
  createOpenRouterProviderFromSecrets,
  type AgentEvent,
  type Tool,
} from '../../src/index.js';

test('large tool results are stored as artifacts with bounded previews', async () => {
  const schema = z.object({});
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'large',
    description: 'large result',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: true,
    async execute() {
      return { content: 'x'.repeat(10_000) };
    },
  };
  const artifacts = new InMemoryArtifactStore();
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'tool_call', id: 'large-call', name: 'large', input: {} },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [tool],
    permissionHandler: new AllowAllPermissionHandler(),
    artifactStore: artifacts,
    maxInlineToolResultChars: 1_000,
  });
  let artifactId: string | undefined;
  for await (const event of session.run({ prompt: 'run' })) {
    if (event.type === 'tool.completed') {
      const artifact = event.result.metadata?.artifact as { id?: string } | undefined;
      artifactId = artifact?.id;
      assert.ok(event.result.content.length < 2_000);
    }
  }
  assert.ok(artifactId);
  assert.equal(String(await artifacts.get(artifactId)).length, 10_000);
});

test('credentials, notifications, and update discovery stay optional adapters', async () => {
  const provider = await createOpenRouterProviderFromSecrets(
    new InMemorySecretProvider({ API_KEY: 'test-key' }),
    { secretName: 'API_KEY', model: 'openai/gpt-4.1-mini' },
  );
  assert.equal(provider.name, 'openrouter');
  assert.equal(provider.defaultModel, 'openai/gpt-4.1-mini');
  await assert.rejects(
    createOpenRouterProviderFromSecrets(new InMemorySecretProvider({}), {
      model: 'openai/gpt-4.1-mini',
    }),
    /Missing provider credential/,
  );

  const notifications: string[] = [];
  const sink = new NotificationSink((notification) => notifications.push(notification.title));
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    eventSink: {
      onEvent(event) {
        sink.onEvent(event);
        throw new Error('observability outage');
      },
    },
  });
  for await (const _event of session.run({ prompt: 'still works' })) {
    // Consume despite the optional sink failure.
  }
  assert.deepEqual(notifications, ['Agent session completed']);

  const version = await checkForUpdate('@trueai/agent-harness', '1.0.0', {
    latest: async () => '1.1.0',
  });
  assert.equal(version.updateAvailable, true);
});

test('budgets stop a session and observability records events', async () => {
  const metrics = new MetricsSink();
  const events: AgentEvent[] = [];
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    budget: { maxTotalTokens: 10 },
    eventSink: {
      onEvent(event) {
        metrics.onEvent(event);
        events.push(event);
      },
    },
  });
  for await (const _event of session.run({ prompt: 'budget' })) {
    // Consume.
  }
  assert.ok(
    events.some(
      (event) => event.type === 'session.completed' && event.reason === 'budget_exceeded',
    ),
  );
  assert.equal(metrics.snapshot().inputTokens, 100);
  assert.equal(metrics.snapshot().errors, 1);
});

test('rate limiter and diagnostics fail predictably', async () => {
  let now = 0;
  const limiter = new SessionRateLimiter({
    maximumRuns: 1,
    windowMs: 1_000,
    clock: () => now,
  });
  assert.equal(limiter.acquire(), true);
  assert.equal(limiter.acquire(), false);
  now = 1_001;
  assert.equal(limiter.acquire(), true);

  const results = await runDiagnostics([
    { name: 'ok', run: async () => ({ status: 'pass', message: 'ready' }) },
    { name: 'bad', run: async () => Promise.reject(new Error('unavailable')) },
  ]);
  assert.equal(results[0]?.status, 'pass');
  assert.equal(results[1]?.status, 'fail');
});

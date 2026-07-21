import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentPlatformSessionManager,
  createAgentSession,
  InMemoryPlatformRuntimeStore,
  InMemorySessionStore,
  resumeAgentSession,
  ScriptedModelProvider,
  type AgentEvent,
  type PlatformPrincipal,
} from '../../src/index.js';

const owner: PlatformPrincipal = {
  tenantId: 'tenant-session',
  userId: 'owner',
  roles: ['executor'],
};

test('platform session manager persists events and replays idempotent runs', async () => {
  const execution = {
    async createSession() {
      return createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'durable result' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
      });
    },
    async resumeSession() {
      throw new Error('not used');
    },
  };
  const runtimeStore = new InMemoryPlatformRuntimeStore();
  const manager = new AgentPlatformSessionManager(execution, runtimeStore);
  await manager.initialize();
  const handle = await manager.create(owner, 'configured-agent');
  const first: AgentEvent[] = [];
  for await (const event of manager.streamRun(
    owner,
    handle.sessionId,
    handle.controlToken,
    'run',
    'stable-run-id',
  )) {
    first.push(event);
  }
  const duplicate: AgentEvent[] = [];
  for await (const event of manager.streamRun(
    owner,
    handle.sessionId,
    handle.controlToken,
    'must not execute twice',
    'stable-run-id',
  )) {
    duplicate.push(event);
  }
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await manager.replay(owner, handle.sessionId), first);
  await manager.close(owner, handle.sessionId, handle.controlToken);
  assert.equal((await runtimeStore.getSession(owner.tenantId, handle.sessionId))?.status, 'closed');
});

test('platform session ownership and control tokens are tenant scoped', async () => {
  const execution = {
    async createSession() {
      return createAgentSession({ provider: new ScriptedModelProvider([]) });
    },
    async resumeSession() {
      throw new Error('not used');
    },
  };
  const manager = new AgentPlatformSessionManager(execution, new InMemoryPlatformRuntimeStore());
  const handle = await manager.create(owner, 'configured-agent');
  await assert.rejects(
    manager.replay({ ...owner, tenantId: 'other' }, handle.sessionId),
    /Unknown/,
  );
  await assert.rejects(
    manager.close(owner, handle.sessionId, 'invalid-token'),
    /Session control denied/,
  );
  await manager.close(owner, handle.sessionId, handle.controlToken);
});

test('platform session manager rehydrates a persisted session after a process restart', async () => {
  const runtimeStore = new InMemoryPlatformRuntimeStore();
  const sessionStore = new InMemorySessionStore();
  const firstProvider = new ScriptedModelProvider([
    [
      { type: 'text_delta', delta: 'before restart' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const secondProvider = new ScriptedModelProvider([
    [
      { type: 'text_delta', delta: 'after restart' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const firstManager = new AgentPlatformSessionManager(
    {
      async createSession() {
        return createAgentSession({ provider: firstProvider, sessionStore });
      },
      async resumeSession() {
        throw new Error('not used before restart');
      },
    },
    runtimeStore,
  );
  const handle = await firstManager.create(owner, 'configured-agent');
  const before: AgentEvent[] = [];
  for await (const event of firstManager.streamRun(
    owner,
    handle.sessionId,
    handle.controlToken,
    'first prompt',
    'before-restart',
  )) {
    before.push(event);
  }
  await firstManager.closeAll();

  const secondManager = new AgentPlatformSessionManager(
    {
      async createSession() {
        throw new Error('not used after restart');
      },
      async resumeSession(_principal, _agent, _environment, sessionId) {
        return resumeAgentSession({ provider: secondProvider, sessionStore }, sessionId);
      },
    },
    runtimeStore,
  );
  const after: AgentEvent[] = [];
  for await (const event of secondManager.streamRun(
    owner,
    handle.sessionId,
    handle.controlToken,
    'second prompt',
    'after-restart',
  )) {
    after.push(event);
  }
  assert.ok(after[0]);
  assert.ok(before.at(-1));
  assert.ok(after[0].sequence > (before.at(-1)?.sequence ?? 0));
  assert.match(
    after
      .filter((event) => event.type === 'assistant.text.delta')
      .map((event) => ('delta' in event ? event.delta : ''))
      .join(''),
    /after restart/,
  );
  assert.deepEqual(await secondManager.replay(owner, handle.sessionId), [...before, ...after]);
  await secondManager.close(owner, handle.sessionId, handle.controlToken);
});

test('platform startup recovers runs orphaned by a stopped synchronous API process', async () => {
  const runtimeStore = new InMemoryPlatformRuntimeStore();
  const createdAt = new Date(0).toISOString();
  await runtimeStore.claimRun({
    id: 'record-id',
    tenantId: owner.tenantId,
    sessionId: 'session-id',
    runId: 'orphaned-run',
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  });
  const manager = new AgentPlatformSessionManager(
    {
      async createSession() {
        throw new Error('not used');
      },
      async resumeSession() {
        throw new Error('not used');
      },
    },
    runtimeStore,
  );
  await manager.initialize();
  const recovered = await runtimeStore.getRun(owner.tenantId, 'session-id', 'orphaned-run');
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.error ?? '', /process stopped/);
});

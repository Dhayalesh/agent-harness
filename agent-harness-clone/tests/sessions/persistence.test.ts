import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentHarnessError,
  createAgentSession,
  FileSessionStore,
  InMemorySessionStore,
  resumeAgentSession,
  ScriptedModelProvider,
} from '../../src/index.js';
import { textMessage } from '../../src/core/messages.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('persists and resumes session messages', async () => {
  const store = new InMemorySessionStore();
  const first = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'first answer' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    sessionStore: store,
  });
  for await (const _event of first.run({ prompt: 'first prompt' })) {
    // Consume the complete turn.
  }
  const resumed = await resumeAgentSession(
    {
      provider: new ScriptedModelProvider([
        (request) => {
          assert.equal(request.messages.length, 3);
          return [
            { type: 'text_delta' as const, delta: 'second answer' },
            { type: 'completed' as const, stopReason: 'end_turn' as const },
          ];
        },
      ]),
      sessionStore: store,
    },
    first.id,
  );
  for await (const _event of resumed.run({ prompt: 'second prompt' })) {
    // Consume the resumed turn.
  }
  assert.equal(resumed.messages.length, 4);
});

test('file session store survives a new store instance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'file-session-store-'));
  try {
    const firstStore = new FileSessionStore(directory);
    const first = createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'persisted' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      sessionStore: firstStore,
    });
    for await (const _event of first.run({ prompt: 'save' })) {
      // Consume.
    }
    const secondStore = new FileSessionStore(directory);
    const stored = await secondStore.load(first.id);
    assert.equal(stored?.messages.length, 2);
    assert.equal((await secondStore.list())[0]?.id, first.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('session start reports whether context was restored', async () => {
  const initial = [textMessage('prior', 'user', 'Earlier context', new Date().toISOString())];
  const session = createAgentSession({
    provider: new ScriptedModelProvider([[{ type: 'completed', stopReason: 'end_turn' }]]),
    initialMessages: initial,
    sessionState: {
      mode: 'persistent',
      resumed: true,
      origin: 'client_history',
    },
  });
  const events = [];
  for await (const event of session.run({ prompt: 'Continue' })) events.push(event);
  const started = events.find((event) => event.type === 'session.started');
  assert.deepEqual(
    started && {
      mode: started.mode,
      resumed: started.resumed,
      origin: started.origin,
      historyMessageCount: started.historyMessageCount,
    },
    {
      mode: 'persistent',
      resumed: true,
      origin: 'client_history',
      historyMessageCount: 1,
    },
  );
});

test('session stores expire inactive transcripts and reject oversized data', async () => {
  const expired = new InMemorySessionStore({ ttlMs: 1 });
  await expired.save({
    version: 1,
    id: 'expired',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    messages: [],
    metadata: {},
  });
  assert.equal(await expired.load('expired'), undefined);

  const bounded = new InMemorySessionStore({ maxBytes: 100 });
  await assert.rejects(
    bounded.save({
      version: 1,
      id: 'large',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [textMessage('message', 'user', 'x'.repeat(200), new Date().toISOString())],
      metadata: {},
    }),
    (error: unknown) => error instanceof AgentHarnessError && error.code === 'SESSION_TOO_LARGE',
  );
});

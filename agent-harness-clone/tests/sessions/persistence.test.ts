import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSession,
  FileSessionStore,
  InMemorySessionStore,
  resumeAgentSession,
  ScriptedModelProvider,
} from '../../src/index.js';
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

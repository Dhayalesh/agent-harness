import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AgentHarnessError,
  createAgentSession,
  FileSessionStore,
  InMemorySessionStore,
  PassthroughContextManager,
  resumeAgentSession,
  ScriptedModelProvider,
  type ContextItem,
  type ContextManager,
  type StoredSession,
} from '../../src/index.js';
import { textMessage } from '../../src/core/messages.js';
import {
  createPreparedContextCheckpoint,
  validateStoredSession,
} from '../../src/sessions/session-store.js';
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

test('prepared checkpoints are separate from canonical history and reject rewritten prefixes', () => {
  const timestamp = new Date().toISOString();
  const canonical = [
    textMessage('u1', 'user', 'Original goal', timestamp),
    textMessage('a1', 'assistant', 'Original answer', timestamp),
  ];
  const prepared = [textMessage('summary', 'user', 'Goal: Original goal', timestamp)];
  const checkpoint = createPreparedContextCheckpoint(prepared, canonical);
  assert.ok(checkpoint);
  assert.equal(checkpoint.sourceMessageCount, canonical.length);
  assert.equal(checkpoint.sourceLastMessageId, 'a1');

  const stored: StoredSession = {
    version: 1,
    id: 'checkpointed',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: canonical,
    preparedContext: checkpoint,
    metadata: {},
  };
  assert.deepEqual(validateStoredSession(stored).messages, canonical);
  assert.deepEqual(validateStoredSession(stored).preparedContext?.messages, prepared);

  const rewritten = structuredClone(stored);
  rewritten.messages[1] = textMessage('different', 'assistant', 'Rewritten', timestamp);
  assert.equal(validateStoredSession(rewritten).preparedContext, undefined);
  assert.deepEqual(validateStoredSession(rewritten).messages, rewritten.messages);
});

test('stored session validation keeps only canonical fields', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const stored = {
    version: 1,
    id: 'canonical-fields-only',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [textMessage('request', 'user', 'Continue', timestamp)],
    metadata: { source: 'persistence-test' },
    retiredDerivedState: { rawRequest: 'must not survive' },
  };

  const validated = validateStoredSession(stored);

  assert.deepEqual(Object.keys(validated).sort(), [
    'createdAt',
    'id',
    'messages',
    'metadata',
    'updatedAt',
    'version',
  ]);
});

test('resumed prepared checkpoints retain canonical tool-result provenance', async () => {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const originalContent = 'canonical output '.repeat(200);
  const canonical: StoredSession['messages'] = [
    {
      id: 'call-message',
      role: 'assistant',
      createdAt: timestamp,
      content: [
        {
          type: 'tool_call',
          id: 'read-call',
          name: 'read_file',
          input: { path: 'docs/current/status.md' },
        },
      ],
    },
    {
      id: 'result-message',
      role: 'user',
      createdAt: timestamp,
      content: [
        {
          type: 'tool_result',
          toolCallId: 'read-call',
          content: originalContent,
          isError: false,
        },
      ],
    },
  ];
  const prepared = structuredClone(canonical);
  const preparedResult = prepared[1]?.content[0];
  assert.equal(preparedResult?.type, 'tool_result');
  if (preparedResult?.type === 'tool_result') preparedResult.content = 'canonical...output';
  const checkpoint = createPreparedContextCheckpoint(prepared, canonical);
  assert.ok(checkpoint);

  const store = new InMemorySessionStore();
  await store.save({
    version: 1,
    id: 'resumed-provenance',
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: canonical,
    preparedContext: checkpoint,
    metadata: {},
  });

  let projected: readonly ContextItem[] = [];
  const delegate = new PassthroughContextManager();
  const contextManager: ContextManager = {
    async prepare(request) {
      const result = await delegate.prepare(request);
      projected = result.items;
      return result;
    },
  };
  const session = await resumeAgentSession(
    {
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'continued' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      sessionStore: store,
      contextManager,
    },
    'resumed-provenance',
  );

  for await (const _event of session.run({ prompt: 'Continue from the saved context.' })) {
    // Consume the resumed turn.
  }

  const observation = projected.find(
    (item) => item.source.kind === 'tool' && item.source.toolCallId === 'read-call',
  );
  assert.ok(observation);
  assert.equal(observation.content, 'canonical...output');
  assert.equal(observation.provenance.toolResult?.transformation, 'truncated');
  assert.equal(
    observation.provenance.toolResult?.originalContentHash,
    createHash('sha256').update(originalContent).digest('hex'),
  );
  assert.equal(
    observation.provenance.toolResult?.originalContentCharacters,
    originalContent.length,
  );
});

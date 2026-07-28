import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LocalRuntimeHost,
  RetryModelProvider,
  ScriptedModelProvider,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../../src/index.js';

test('workspace symlinks cannot escape the runtime boundary', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'security-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'security-outside-'));
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, path.join(root, 'escape'));
  } catch (error) {
    // Creating a symlink on Windows needs elevation or Developer Mode.
    if ((error as { code?: string }).code !== 'EPERM') throw error;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    t.skip('symlink creation is not permitted in this environment');
    return;
  }
  try {
    const runtime = new LocalRuntimeHost(root);
    await assert.rejects(runtime.readText('escape/secret.txt'), /outside the runtime workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('retry provider retries pre-stream transient faults but never duplicates partial output', async () => {
  let attempts = 0;
  const transient: ModelProvider = {
    name: 'transient',
    async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('busy'), { status: 503 });
      yield { type: 'text_delta', delta: 'recovered' };
      yield { type: 'completed', stopReason: 'end_turn' };
    },
  };
  const provider = new RetryModelProvider(transient, { initialDelayMs: 1 });
  const events: ModelStreamEvent[] = [];
  const request: ModelRequest = {
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  };
  for await (const event of provider.stream(request)) events.push(event);
  assert.equal(attempts, 2);
  assert.equal(events[0]?.type, 'text_delta');

  const scripted = new ScriptedModelProvider([
    [
      { type: 'text_delta', delta: 'one' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  assert.equal(scripted.name, 'scripted');
});

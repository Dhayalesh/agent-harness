import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentHarnessError, RetryModelProvider, type ModelRequest } from '../../src/index.js';

const baseRequest: ModelRequest = {
  messages: [
    {
      id: 'user',
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: 'Hello' }],
    },
  ],
  tools: [],
  signal: new AbortController().signal,
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

test('retries once on malformed tool-call JSON and succeeds on the second attempt', async () => {
  let attempts = 0;
  const provider = {
    name: 'fake',
    async *stream(): AsyncIterable<import('../../src/index.js').ModelStreamEvent> {
      attempts += 1;
      if (attempts === 1) {
        throw new AgentHarnessError(
          'Model returned malformed JSON for tool browser_use',
          'MALFORMED_TOOL_JSON',
          false,
        );
      }
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'completed', stopReason: 'end_turn' };
    },
  };
  const retrying = new RetryModelProvider(provider, { initialDelayMs: 1 });
  const events = await collect(retrying.stream(baseRequest));

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    ['warning', 'text_delta', 'completed'],
  );
});

test('does not retry malformed tool-call JSON once real output has already streamed', async () => {
  let attempts = 0;
  const provider = {
    name: 'fake',
    async *stream(): AsyncIterable<import('../../src/index.js').ModelStreamEvent> {
      attempts += 1;
      yield { type: 'text_delta', delta: 'partial' };
      throw new AgentHarnessError(
        'Model returned malformed JSON for tool x',
        'MALFORMED_TOOL_JSON',
        false,
      );
    },
  };
  const retrying = new RetryModelProvider(provider, { initialDelayMs: 1 });

  await assert.rejects(() => collect(retrying.stream(baseRequest)));
  assert.equal(attempts, 1);
});

test('still fails without retrying a non-retryable, non-HTTP error', async () => {
  let attempts = 0;
  const provider = {
    name: 'fake',
    async *stream(): AsyncIterable<import('../../src/index.js').ModelStreamEvent> {
      attempts += 1;
      throw new AgentHarnessError('Budget exceeded', 'BUDGET_EXCEEDED', false);
      // eslint-disable-next-line no-unreachable
      yield { type: 'completed', stopReason: 'end_turn' };
    },
  };
  const retrying = new RetryModelProvider(provider, { initialDelayMs: 1 });

  await assert.rejects(() => collect(retrying.stream(baseRequest)));
  assert.equal(attempts, 1);
});

test('still retries a plain HTTP 429-style error (existing behavior unaffected)', async () => {
  let attempts = 0;
  const provider = {
    name: 'fake',
    async *stream(): AsyncIterable<import('../../src/index.js').ModelStreamEvent> {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      }
      yield { type: 'completed', stopReason: 'end_turn' };
    },
  };
  const retrying = new RetryModelProvider(provider, { initialDelayMs: 1 });
  const events = await collect(retrying.stream(baseRequest));

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    ['warning', 'completed'],
  );
});

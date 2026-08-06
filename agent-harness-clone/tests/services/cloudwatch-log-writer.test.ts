import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudWatchLogWriter, StructuredLogSink } from '../../src/index.js';

/**
 * Exercises the writer against a fake CloudWatch client, so batching, routing, retry,
 * and the drop policy are asserted rather than inferred. Nothing here reaches AWS.
 */

type SentBatch = { group: string; stream: string; messages: string[] };

/**
 * Stands in for `CloudWatchLogsClient`. Only `send` is used by the writer, so only
 * `send` is implemented; commands are recognised by their constructor name, which is
 * what the SDK sets and what survives bundling.
 */
function fakeClient(options: { failTimes?: number; failWith?: string } = {}) {
  const batches: SentBatch[] = [];
  const created: string[] = [];
  let groups = 0;
  let remainingFailures = options.failTimes ?? 0;
  const client = {
    send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const kind = command.constructor.name;
      if (kind === 'CreateLogGroupCommand') {
        groups += 1;
        return Promise.resolve({});
      }
      if (kind === 'CreateLogStreamCommand') {
        created.push(String(command.input.logStreamName));
        return Promise.resolve({});
      }
      if (kind === 'PutLogEventsCommand') {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          const error = new Error('throttled');
          error.name = options.failWith ?? 'ThrottlingException';
          return Promise.reject(error);
        }
        batches.push({
          group: String(command.input.logGroupName),
          stream: String(command.input.logStreamName),
          messages: (command.input.logEvents as Array<{ message: string }>).map(
            (event) => event.message,
          ),
        });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
  return {
    batches,
    created,
    client,
    groupCreations: () => groups,
  };
}

function writerFor(
  fake: ReturnType<typeof fakeClient>,
  overrides: Record<string, unknown> = {},
): CloudWatchLogWriter {
  return new CloudWatchLogWriter({
    logGroupName: '/agent-harness/test',
    client: fake.client as never,
    flushIntervalMs: 200,
    fallbackWrite: () => undefined,
    ...overrides,
  });
}

test('lines are routed to one stream per session', async () => {
  const fake = fakeClient();
  const writer = writerFor(fake);

  for (const sessionId of ['alpha', 'alpha', 'beta']) {
    writer.write(
      JSON.stringify({ event: 'invocation.started', sessionId, timestamp: '2026-08-06T10:00:00Z' }),
    );
  }
  await writer.close();

  const streams = fake.batches.map((batch) => batch.stream);
  assert.equal(new Set(streams).size, 2);
  assert.ok(streams.every((stream) => stream.startsWith('2026/08/06/')));
  // Two invocations of one session travel together; the third is separate.
  const alpha = fake.batches.find((batch) => batch.stream.endsWith('alpha'));
  assert.equal(alpha?.messages.length, 2);
  assert.equal(fake.groupCreations(), 1);
});

test('a line without a session is still delivered', async () => {
  const fake = fakeClient();
  const writer = writerFor(fake);

  writer.write(JSON.stringify({ event: 'runtime.started' }));
  await writer.close();

  assert.equal(fake.batches.length, 1);
  assert.ok(fake.batches[0]?.stream.endsWith('no-session'));
});

test('throttling is retried rather than dropped', async () => {
  const fake = fakeClient({ failTimes: 2 });
  const writer = writerFor(fake, { maxRetries: 5 });

  writer.write(JSON.stringify({ event: 'tool.completed', sessionId: 'retry-me' }));
  await writer.close();

  assert.equal(fake.batches.length, 1);
  assert.equal(fake.batches[0]?.messages.length, 1);
});

test('a non-retryable failure is reported to the fallback, not retried forever', async () => {
  const fake = fakeClient({ failTimes: 99, failWith: 'AccessDeniedException' });
  const reported: string[] = [];
  const writer = writerFor(fake, {
    maxRetries: 5,
    fallbackWrite: (line: string) => reported.push(line),
  });

  writer.write(JSON.stringify({ event: 'tool.completed', sessionId: 'denied' }));
  await writer.close();

  assert.equal(fake.batches.length, 0);
  const events = reported.map((line) => (JSON.parse(line) as { event: string }).event);
  assert.ok(events.includes('cloudwatch.flush.failed'));
});

test('the queue is bounded and drops oldest, reporting how many', async () => {
  const fake = fakeClient();
  const reported: string[] = [];
  const writer = writerFor(fake, {
    maxQueuedEvents: 100,
    fallbackWrite: (line: string) => reported.push(line),
  });

  for (let index = 0; index < 150; index += 1) {
    writer.write(JSON.stringify({ event: 'noise', sessionId: 'flood', index }));
  }
  await writer.close();

  const delivered = fake.batches.flatMap((batch) => batch.messages);
  assert.equal(delivered.length, 100);
  // Oldest dropped, so the newest line survives — that is the one describing now.
  const indexes = delivered.map((line) => (JSON.parse(line) as { index: number }).index);
  assert.equal(indexes.at(-1), 149);
  assert.ok(!indexes.includes(0));

  const dropped = reported
    .map((line) => JSON.parse(line) as { event: string; dropped?: number })
    .find((record) => record.event === 'cloudwatch.events.dropped');
  assert.equal(dropped?.dropped, 50);
});

test('batches are ordered by timestamp, as CloudWatch requires', async () => {
  const fake = fakeClient();
  const writer = writerFor(fake);

  for (const timestamp of [
    '2026-08-06T10:00:02Z',
    '2026-08-06T10:00:00Z',
    '2026-08-06T10:00:01Z',
  ]) {
    writer.write(JSON.stringify({ event: 'e', sessionId: 'ordered', timestamp }));
  }
  await writer.close();

  const timestamps = fake.batches
    .flatMap((batch) => batch.messages)
    .map((line) => Date.parse((JSON.parse(line) as { timestamp: string }).timestamp));
  assert.deepEqual(
    timestamps,
    [...timestamps].sort((left, right) => left - right),
  );
});

test('it composes with StructuredLogSink, inheriting redaction', async () => {
  const fake = fakeClient();
  const writer = writerFor(fake);
  const sink = new StructuredLogSink(writer.write);

  sink.log({
    event: 'invocation.started',
    sessionId: 'redacted-session',
    payload: { modelProvider: { apiKey: 'sk-should-not-appear-12345678' } },
  });
  await writer.close();

  const delivered = fake.batches.flatMap((batch) => batch.messages).join('\n');
  assert.ok(delivered.includes('redacted-session'));
  assert.doesNotMatch(delivered, /sk-should-not-appear/);
});

test('a write after close does not throw', async () => {
  const fake = fakeClient();
  const writer = writerFor(fake);
  await writer.close();
  assert.doesNotThrow(() => writer.write(JSON.stringify({ event: 'late', sessionId: 'x' })));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLogLevel, StructuredLogSink } from '../../src/services/observability.js';
import { REDACTED } from '../../src/services/redact.js';

type JsonRecord = Record<string, unknown>;

function json(line: string): JsonRecord {
  return JSON.parse(line) as JsonRecord;
}

test('parseLogLevel defaults empty input, normalizes valid input, and rejects typos', () => {
  assert.equal(parseLogLevel(undefined), 'info');
  assert.equal(parseLogLevel('   ', 'warn'), 'warn');
  assert.equal(parseLogLevel(' DEBUG '), 'debug');
  assert.throws(
    () => parseLogLevel('verbose'),
    /Invalid log level "verbose"; expected one of: debug, info, warn, error/,
  );
});

test('StructuredLogSink filters records below its minimum level', () => {
  const lines: string[] = [];
  const sink = new StructuredLogSink((line) => lines.push(line), { minimumLevel: 'warn' });

  sink.log({ level: 'debug', event: 'diagnostic.detail' });
  sink.log({ event: 'invocation.started' });
  sink.log({ level: 'warn', event: 'model.retry.scheduled' });
  sink.log({ level: 'error', event: 'invocation.failed' });

  assert.deepEqual(
    lines.map((line) => json(line).level),
    ['warn', 'error'],
  );
  assert.deepEqual(
    lines.map((line) => json(line).logSequence),
    [1, 2],
  );
});

test('StructuredLogSink writes a readable ordered envelope and preserves status', () => {
  const lines: string[] = [];
  const sink = new StructuredLogSink((line) => lines.push(line), {
    context: {
      invocationId: 'invocation-readable',
      modelRequestId: 'model-request-readable',
      mcpRequestId: 'mcp-request-readable',
    },
    clock: () => new Date('2026-08-06T12:34:56.000Z'),
  });

  sink.log({ event: 'invocation.started' });
  sink.log({
    event: 'invocation.completed',
    status: 'success',
    durationMs: 42,
  });

  const started = json(lines[0] as string);
  assert.deepEqual(Object.keys(started).slice(0, 9), [
    'timestamp',
    'level',
    'category',
    'event',
    'message',
    'outcome',
    'component',
    'schemaVersion',
    'logSequence',
  ]);
  assert.equal(started.schemaVersion, 1);
  assert.equal(started.category, 'invocation');
  assert.equal(started.message, 'Invocation started');
  assert.equal(started.outcome, 'started');
  assert.equal(started.logSequence, 1);
  assert.equal(started.modelRequestId, 'model-request-readable');
  assert.equal(started.mcpRequestId, 'mcp-request-readable');

  const completed = json(lines[1] as string);
  assert.equal(completed.message, 'Invocation completed');
  assert.equal(completed.outcome, 'success');
  assert.equal(completed.status, 'success');
  assert.equal(completed.logSequence, 2);
});

test('noisy AgentEvents require debug opt-in while failed tools remain errors', () => {
  const base = {
    protocolVersion: 1 as const,
    timestamp: '2026-08-06T12:34:56.000Z',
    sessionId: 'session-debug',
  };
  const delta = {
    ...base,
    sequence: 1,
    type: 'assistant.text.delta' as const,
    turnId: 'turn-debug',
    delta: 'partial answer',
  };
  const successfulTool = {
    ...base,
    sequence: 2,
    type: 'tool.completed' as const,
    turnId: 'turn-debug',
    result: {
      type: 'tool_result' as const,
      toolCallId: 'tool-success',
      content: 'done',
      isError: false,
    },
  };
  const failedTool = {
    ...base,
    sequence: 3,
    type: 'tool.completed' as const,
    turnId: 'turn-debug',
    result: {
      type: 'tool_result' as const,
      toolCallId: 'tool-failed',
      content: 'failed',
      isError: true,
    },
  };

  const defaultLines: string[] = [];
  const defaultSink = new StructuredLogSink((line) => defaultLines.push(line));
  defaultSink.onEvent(delta);
  defaultSink.onEvent(successfulTool);
  defaultSink.onEvent(failedTool);
  assert.equal(defaultLines.length, 1);
  assert.equal(json(defaultLines[0] as string).level, 'error');

  const debugLines: string[] = [];
  const debugSink = new StructuredLogSink((line) => debugLines.push(line), {
    minimumLevel: 'debug',
  });
  debugSink.onEvent(delta);
  debugSink.onEvent(successfulTool);
  assert.deepEqual(
    debugLines.map((line) => json(line).level),
    ['debug', 'debug'],
  );
  assert.ok(debugLines.map(json).every((record) => typeof record.message === 'string'));
});

test('StructuredLogSink writes contextual JSON and recursively redacts credentials', () => {
  const lines: string[] = [];
  const sink = new StructuredLogSink(
    (line) => {
      lines.push(line);
    },
    {
      context: {
        invocationId: 'invocation-1',
        requestId: 'request-1',
        runtimeSessionId: 'runtime-session-1',
      },
      clock: () => new Date('2026-08-06T12:34:56.000Z'),
    },
  );

  sink.log({
    event: 'invocation.started',
    provider: 'openrouter',
    payload: {
      modelProvider: {
        model: 'example/model',
        apiKey: 'model-api-key-secret',
      },
      mcpServers: [
        {
          headers: {
            Authorization: 'Bearer header-secret-value',
            'x-safe-header': 'opaque-header-secret',
            'content-type': 'application/json',
          },
          env: {
            MCP_API_KEY: 'mcp-env-secret',
            SAFE_SETTING: 'opaque-env-secret',
          },
          url: 'https://mcp.example.test/run?token=url-query-secret&limit=5',
          auth: 'opaque-auth-secret',
          args: [
            '--mode',
            'stdio',
            '--token',
            'opaque-cli-secret',
            '--header=opaque-inline-secret',
          ],
        },
      ],
      usage: {
        inputTokens: 21,
        outputTokens: 8,
        cacheReadTokens: 3,
      },
    },
  });

  assert.equal(lines.length, 1);
  const record = json(lines[0] as string);
  assert.equal(record.component, 'agent-harness');
  assert.equal(record.timestamp, '2026-08-06T12:34:56.000Z');
  assert.equal(record.level, 'info');
  assert.equal(record.event, 'invocation.started');
  assert.equal(record.invocationId, 'invocation-1');
  assert.equal(record.requestId, 'request-1');
  assert.equal(record.runtimeSessionId, 'runtime-session-1');
  assert.equal(record.provider, 'openrouter');

  const payload = record.payload as JsonRecord;
  const modelProvider = payload.modelProvider as JsonRecord;
  assert.equal(modelProvider.model, 'example/model');
  assert.equal(modelProvider.apiKey, REDACTED);

  const server = (payload.mcpServers as JsonRecord[])[0] as JsonRecord;
  const headers = server.headers as JsonRecord;
  assert.equal(headers.Authorization, REDACTED);
  assert.equal(headers['x-safe-header'], REDACTED);
  assert.equal(headers['content-type'], 'application/json');
  const env = server.env as JsonRecord;
  assert.equal(env.MCP_API_KEY, REDACTED);
  assert.equal(env.SAFE_SETTING, REDACTED);
  assert.equal(server.auth, REDACTED);
  assert.deepEqual(server.args, ['--mode', 'stdio', '--token', REDACTED, '--header=' + REDACTED]);

  const redactedUrl = new URL(server.url as string);
  assert.equal(redactedUrl.searchParams.get('token'), REDACTED);
  assert.equal(redactedUrl.searchParams.get('limit'), '5');

  const usage = payload.usage as JsonRecord;
  assert.equal(usage.inputTokens, 21);
  assert.equal(usage.outputTokens, 8);
  assert.equal(usage.cacheReadTokens, 3);
  assert.doesNotMatch(
    lines[0] as string,
    /model-api-key-secret|header-secret-value|opaque-header-secret|mcp-env-secret|opaque-env-secret|url-query-secret|opaque-auth-secret|opaque-cli-secret|opaque-inline-secret/,
  );
});

test('StructuredLogSink redacts database credentials, signed URLs, and unreadable values', () => {
  const lines: string[] = [];
  const unreadable = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(unreadable, 'value', {
    enumerable: true,
    get() {
      throw new Error('getter secret should not escape');
    },
  });
  const sink = new StructuredLogSink((line) => lines.push(line));

  sink.log({
    event: 'invocation.started',
    databaseUrl: 'postgres://database-user:database-password@db.example.test/app',
    signedUrl: 'https://example.test/object?sig=signed-secret&limit=10',
    unreadable,
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(
    lines[0] as string,
    /database-user|database-password|signed-secret|getter secret/,
  );
  const record = json(lines[0] as string);
  const databaseUrl = new URL(String(record.databaseUrl));
  assert.equal(decodeURIComponent(databaseUrl.username), REDACTED);
  assert.equal(decodeURIComponent(databaseUrl.password), REDACTED);
  const signedUrl = new URL(String(record.signedUrl));
  assert.equal(signedUrl.searchParams.get('sig'), REDACTED);
  assert.equal(signedUrl.searchParams.get('limit'), '10');
  assert.deepEqual(record.unreadable, { value: '[unreadable]' });
});

test('StructuredLogSink safely serializes cycles and bigint values', () => {
  const lines: string[] = [];
  const cyclic: Record<string, unknown> = {
    name: 'root',
    count: 9_007_199_254_740_993n,
  };
  cyclic.self = cyclic;

  const sink = new StructuredLogSink((line) => {
    lines.push(line);
  });
  assert.doesNotThrow(() =>
    sink.log({
      event: 'tool.completed',
      result: cyclic,
    }),
  );

  assert.equal(lines.length, 1);
  const record = json(lines[0] as string);
  const result = record.result as JsonRecord;
  assert.equal(result.name, 'root');
  assert.equal(result.count, '9007199254740993n');
  assert.equal(result.self, '[circular]');
});

test('StructuredLogSink is fail-open when primary and fallback writers throw', () => {
  const fallback: string[] = [];
  const sink = new StructuredLogSink(
    () => {
      throw new Error('primary writer unavailable');
    },
    {
      clock: () => new Date('2026-08-06T12:34:56.000Z'),
      fallbackWrite: (line) => {
        fallback.push(line);
      },
    },
  );

  assert.doesNotThrow(() => sink.log({ event: 'invocation.started' }));
  assert.equal(fallback.length, 1);
  const failure = json(fallback[0] as string);
  assert.equal(failure.event, 'observability.write.failed');
  assert.equal(failure.level, 'error');
  assert.equal(failure.message, 'Structured log writer failed');
  assert.equal(failure.errorName, 'Error');

  const fullyBroken = new StructuredLogSink(
    () => {
      throw new Error('primary writer unavailable');
    },
    {
      fallbackWrite: () => {
        throw new Error('fallback writer unavailable');
      },
    },
  );
  assert.doesNotThrow(() => fullyBroken.log({ event: 'invocation.started' }));
});

test('StructuredLogSink chunks oversized JSON into bounded reassemblable lines', () => {
  const lines: string[] = [];
  const maximumBytes = 4_096;
  const output = 'segment: quoted="yes" slash=\\\\ emoji=😀 newline=\\n'.repeat(800);
  const sink = new StructuredLogSink(
    (line) => {
      lines.push(line);
    },
    {
      maxLineBytes: maximumBytes,
      clock: () => new Date('2026-08-06T12:34:56.000Z'),
      context: {
        invocationId: 'invocation-large',
        modelRequestId: 'model-request-large',
        mcpRequestId: 'mcp-request-large',
      },
    },
  );

  sink.log({
    event: 'tool.completed',
    toolCallId: 'tool-call-large',
    data: {
      output,
      inputTokens: 44,
      outputTokens: 12,
    },
  });

  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(
      Buffer.byteLength(line, 'utf8') <= maximumBytes,
      'every physical JSON line must stay within maxLineBytes',
    );
  }

  const chunks = lines.map(json);
  const first = chunks[0] as JsonRecord;
  assert.equal(first.event, 'log.chunk');
  assert.equal(first.originalEvent, 'tool.completed');
  assert.equal(first.encoding, 'json-fragment');

  const chunkId = first.chunkId;
  assert.equal(typeof chunkId, 'string');
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.chunkId, chunkId);
    assert.equal(chunk.chunkIndex, index + 1);
    assert.equal(chunk.chunkCount, chunks.length);
    assert.equal(chunk.invocationId, 'invocation-large');
    assert.equal(chunk.toolCallId, 'tool-call-large');
    assert.equal(chunk.modelRequestId, 'model-request-large');
    assert.equal(chunk.mcpRequestId, 'mcp-request-large');
    assert.equal(chunk.schemaVersion, 1);
    assert.equal(chunk.logSequence, 1);
    assert.equal(typeof chunk.message, 'string');
  }

  const reconstructed = chunks.map((chunk) => String(chunk.content)).join('');
  const original = json(reconstructed);
  assert.equal(original.component, 'agent-harness');
  assert.equal(original.event, 'tool.completed');
  assert.equal(original.invocationId, 'invocation-large');
  assert.equal(original.toolCallId, 'tool-call-large');
  assert.equal(original.logSequence, 1);
  const data = original.data as JsonRecord;
  assert.equal(data.output, output);
  assert.equal(data.inputTokens, 44);
  assert.equal(data.outputTokens, 12);
});

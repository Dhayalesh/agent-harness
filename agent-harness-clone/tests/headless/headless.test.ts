import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentHarnessError,
  createBuiltinTools,
  invokeHeadless,
  LocalRuntimeHost,
  parseInvocationPayload,
  resolveInlineAgent,
  startHeadlessServer,
  StructuredLogSink,
  streamHeadless,
  type InvocationPayloadInput,
} from '../../src/index.js';

/**
 * Exercises the headless path with no MongoDB, no S3, and no AWS variables: a payload
 * goes in and an answer comes out. The model is a local HTTP server speaking the
 * OpenAI-compatible wire format, so the run is real from the session down — the same
 * `PlatformAgentRegistry` assembly, the same permission handler, the same tools.
 */

/** One SSE frame in the shape the provider parses. */
function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function toolCallChunk(id: string, name: string, args: unknown): string {
  return (
    frame({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: null,
        },
      ],
    }) + frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  );
}

function textChunk(text: string): string {
  return (
    frame({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    frame({ usage: { prompt_tokens: 120, completion_tokens: 30 } })
  );
}

/**
 * A model endpoint that replays a fixed script, one entry per request. Also records
 * every request body, which is how the tools and the system prompt a payload produced
 * are asserted rather than inferred.
 */
async function scriptedEndpoint(script: readonly string[]): Promise<{
  baseURL: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      const body = script[cursor++];
      if (body === undefined) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('script exhausted');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${body}data: [DONE]\n\n`);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function payload(baseURL: string, overrides: Partial<InvocationPayloadInput> = {}) {
  return {
    prompt: 'Write hello.txt with the text "hi", then confirm.',
    agent: {
      name: 'payload-demo',
      systemPrompt: 'You write files when asked.',
      tools: ['write_file', 'read_file'],
      limits: { maxTurns: 4 },
    },
    modelProvider: {
      name: 'local-fake',
      provider: 'openai-compatible' as const,
      model: 'fake-model',
      baseURL,
      apiKey: 'test-key',
    },
    permissionRules: [{ tool: 'write_file', decision: 'allow' as const }],
    ...overrides,
  } satisfies InvocationPayloadInput;
}

test('invocations in one transport session share a sessionId in their logs', async (t) => {
  const endpoint = await scriptedEndpoint([
    textChunk('First.'),
    textChunk('Second.'),
    textChunk('Third.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-session-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // Two invocations under one transport session, then one under another. This is the
  // AgentCore shape: the session id arrives on a header and the payloads never name
  // one, which previously left each invocation with its own generated sessionId.
  const runs = [
    { sessionId: 'session-alpha', lines: [] as string[] },
    { sessionId: 'session-alpha', lines: [] as string[] },
    { sessionId: 'session-beta', lines: [] as string[] },
  ];
  for (const run of runs) {
    await invokeHeadless(payload(endpoint.baseURL), {
      sessionId: run.sessionId,
      workspaceRoot,
      builtinToolOptions: { powershell: false },
      logSink: new StructuredLogSink((line) => run.lines.push(line)),
    });
  }

  const sessionIdsOf = (lines: readonly string[]): Set<string> =>
    new Set(
      lines
        .map((line) => (JSON.parse(line) as { sessionId?: string }).sessionId)
        .filter((value): value is string => value !== undefined),
    );

  for (const run of runs) {
    assert.deepEqual([...sessionIdsOf(run.lines)], [run.sessionId]);
    // The very first record predates payload validation, so this is what proves a
    // rejected payload would still be attributable to its session.
    const first = JSON.parse(run.lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(first.event, 'invocation.started');
    assert.equal(first.sessionId, run.sessionId);
  }

  // Grouped by session, but still separable by invocation within it.
  const invocationIds = runs
    .slice(0, 2)
    .map((run) => JSON.parse(run.lines[0] ?? '{}') as { invocationId: string })
    .map((record) => record.invocationId);
  assert.equal(new Set(invocationIds).size, 2);
});

test('an explicit payload sessionId outranks the transport session', async (t) => {
  const endpoint = await scriptedEndpoint([textChunk('Named.')]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-session-named-'));
  const lines: string[] = [];
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(payload(endpoint.baseURL, { sessionId: 'from-payload' }), {
    sessionId: 'from-transport',
    workspaceRoot,
    builtinToolOptions: { powershell: false },
    logSink: new StructuredLogSink((line) => lines.push(line)),
  });

  assert.equal(result.sessionId, 'from-payload');
  const validated = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record.event === 'invocation.payload.validated');
  assert.equal(validated?.sessionId, 'from-payload');
});

test('a payload runs a full turn with no database, no S3, and no env vars', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-1', 'write_file', { path: 'hello.txt', content: 'hi' }),
    textChunk('Wrote hello.txt.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-run-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(payload(endpoint.baseURL), {
    workspaceRoot,
    builtinToolOptions: { powershell: false },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.output, 'Wrote hello.txt.');
  assert.equal(result.agentName, 'payload-demo');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(
    result.tools.map((tool) => [tool.name, tool.calls, tool.errors]),
    [['write_file', 1, 0]],
  );
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 30);

  // The tool actually ran against the run's own workspace.
  assert.equal(await readFile(path.join(result.workingDirectory, 'hello.txt'), 'utf8'), 'hi');
  assert.ok(result.workingDirectory.startsWith(workspaceRoot));

  // The payload's prompt and tool selection reached the model, and nothing else did.
  const first = endpoint.requests[0] as Record<string, unknown>;
  const tools = first.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), ['read_file', 'write_file']);
  const messages = first.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[0]?.content ?? '', /You write files when asked\./);
});

test('structured logs cover the full invocation, model, and tool lifecycle', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-logged', 'write_file', { path: 'logged.txt', content: 'logged' }),
    textChunk('Logged.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-logged-'));
  const lines: string[] = [];
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(payload(endpoint.baseURL), {
    invocationId: 'invocation-logged',
    workspaceRoot,
    builtinToolOptions: { powershell: false },
    logSink: new StructuredLogSink((line) => lines.push(line)),
  });
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const events = records.map((record) => String(record.event));

  assert.equal(result.sessionId, 'invocation-logged');
  assert.equal(events[0], 'invocation.started');
  assert.ok(events.includes('invocation.payload.validated'));
  assert.ok(events.includes('agent.resolution.started'));
  assert.ok(events.includes('model.request.started'));
  assert.ok(events.includes('model.attempt.started'));
  assert.ok(events.includes('tool.requested'));
  assert.ok(events.includes('tool.execution.started'));
  assert.ok(events.includes('tool.execution.completed'));
  assert.ok(events.includes('invocation.cleanup.completed'));
  assert.equal(events.at(-1), 'invocation.completed');
  assert.ok(
    events.indexOf('invocation.cleanup.completed') < events.indexOf('invocation.completed'),
  );
  assert.ok(records.every((record) => record.invocationId === 'invocation-logged'));

  const start = records[0] as {
    payload: { modelProvider: { apiKey: string }; prompt: string };
  };
  assert.match(start.payload.prompt, /^Write hello\.txt with the text/);
  assert.equal(start.payload.modelProvider.apiKey, '[redacted]');
  assert.doesNotMatch(lines.join('\n'), /test-key/);

  const completed = records.at(-1) as {
    result: { usage: { inputTokens: number; outputTokens: number } };
  };
  assert.equal(completed.result.usage.inputTokens, 120);
  assert.equal(completed.result.usage.outputTokens, 30);
});

test('the event stream is the same protocol the other transports emit', async (t) => {
  const endpoint = await scriptedEndpoint([textChunk('Done.')]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-stream-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const types: string[] = [];
  for await (const event of streamHeadless(payload(endpoint.baseURL, { prompt: 'Say done.' }), {
    workspaceRoot,
    builtinToolOptions: { powershell: false },
  })) {
    types.push(event.type);
    assert.equal(event.protocolVersion, 1);
  }

  assert.equal(types[0], 'session.started');
  assert.ok(types.includes('assistant.text.delta'));
  assert.equal(types.at(-1), 'session.completed');
});

test('an inlined skill is materialized from the payload instead of a bucket', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-skill-'));
  const runtime = new LocalRuntimeHost(workspaceRoot);
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const parsed = parseInvocationPayload({
    prompt: 'Review it.',
    agent: {
      name: 'reviewer',
      systemPrompt: 'You review code.',
      tools: ['read_file'],
    },
    modelProvider: {
      name: 'local-fake',
      provider: 'openai-compatible',
      model: 'fake-model',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
    },
    skills: [
      {
        name: 'abap-review',
        document: [
          '---',
          'description: Checklist for reviewing an ABAP change',
          'allowedTools: read_file',
          '---',
          'Read the object, then check for hardcoded clients.',
        ].join('\n'),
      },
    ],
  });

  const agent = await resolveInlineAgent(parsed, {
    localTools: createBuiltinTools(runtime, { powershell: false }),
  });
  t.after(() => agent.close());

  assert.deepEqual(
    agent.tools.map((tool) => tool.name),
    ['read_file', 'skill'],
  );
  assert.deepEqual(
    agent.skillRecords.map((record) => record.name),
    ['abap-review'],
  );
  // Written to the run's temporary directory in the layout `loadSkillsDirectory` reads,
  // so a payload skill is an ordinary skill file rather than a special case.
  const onDisk = await readFile(path.join(agent.skillDirectory, 'abap-review', 'SKILL.md'), 'utf8');
  assert.match(onDisk, /hardcoded clients/);
  // Limits derived from the provider's defaults: the window less the reply.
  assert.equal(agent.limits.maxOutputTokens, 8_192);
  assert.equal(agent.limits.maxInputTokens, 200_000 - 8_192);
});

test('a payload naming a tool that does not exist is refused, not ignored', async () => {
  const parsed = parseInvocationPayload({
    prompt: 'Go.',
    agent: { name: 'a', systemPrompt: 'p', tools: ['teleport'] },
    modelProvider: {
      name: 'local-fake',
      provider: 'openai-compatible',
      model: 'fake-model',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
    },
  });
  // Caught by the same support gate a stored record goes through, before any
  // connection is opened.
  await assert.rejects(
    resolveInlineAgent(parsed, { localTools: [] }),
    (error: unknown) =>
      error instanceof AgentHarnessError && error.code === 'UNSUPPORTED_AGENT_TOOL',
  );
});

test('a payload naming a real tool this host did not build is refused too', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-tools-'));
  const runtime = new LocalRuntimeHost(workspaceRoot);
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const parsed = parseInvocationPayload({
    prompt: 'Go.',
    agent: { name: 'a', systemPrompt: 'p', tools: ['powershell'] },
    modelProvider: {
      name: 'local-fake',
      provider: 'openai-compatible',
      model: 'fake-model',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
    },
  });
  await assert.rejects(
    resolveInlineAgent(parsed, {
      localTools: createBuiltinTools(runtime, { powershell: false }),
    }),
    (error: unknown) =>
      error instanceof AgentHarnessError && error.code === 'AGENT_TOOL_NOT_AVAILABLE',
  );
});

test('an unrecognised payload field fails rather than running without it', async () => {
  const lines: string[] = [];
  await assert.rejects(
    async () =>
      invokeHeadless(
        {
          prompt: 'Go.',
          agent: { name: 'a', system_prompt: 'p' },
          modelProvider: {
            name: 'local-fake',
            provider: 'openai-compatible',
            model: 'fake-model',
            baseURL: 'http://127.0.0.1:1/v1',
            apiKey: 'test-key',
          },
        },
        {
          invocationId: 'invalid-invocation',
          logSink: new StructuredLogSink((line) => lines.push(line)),
        },
      ),
    (error: unknown) =>
      error instanceof AgentHarnessError && error.code === 'HEADLESS_PAYLOAD_INVALID',
  );
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.map((record) => record.event),
    ['invocation.started', 'invocation.failed'],
  );
  assert.equal(records[1]?.phase, 'validation');
  assert.equal(records[1]?.invocationId, 'invalid-invocation');
  assert.doesNotMatch(lines.join('\n'), /test-key/);
});

test('the host permission ceiling overrides a payload that asks for bypass', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-1', 'write_file', { path: 'blocked.txt', content: 'x' }),
    textChunk('Could not write.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-ceiling-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(
    payload(endpoint.baseURL, { permissionMode: 'bypass', permissionRules: [] }),
    { workspaceRoot, permissionCeiling: 'plan', builtinToolOptions: { powershell: false } },
  );

  assert.equal(result.status, 'success');
  assert.deepEqual(
    result.tools.map((tool) => [tool.name, tool.errors]),
    [['write_file', 1]],
  );
  await assert.rejects(() => readFile(path.join(result.workingDirectory, 'blocked.txt'), 'utf8'));
});

test('the server accepts a payload on POST /invocations and enforces its key', async (t) => {
  const endpoint = await scriptedEndpoint([textChunk('Served.')]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-server-'));
  const logLines: string[] = [];
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    serviceKey: 'secret',
    workspaceRoot,
    builtinToolOptions: { powershell: false },
    logSink: new StructuredLogSink((line) => logLines.push(line)),
  });
  t.after(async () => {
    await running.close();
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const body = JSON.stringify(payload(endpoint.baseURL, { prompt: 'Say served.' }));

  const unauthorized = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-service-key': 'secret',
      'x-amzn-bedrock-agentcore-runtime-session-id': 'runtime-session-1',
      'x-amzn-trace-id': 'Root=trace-1',
    },
    body,
  });
  assert.equal(authorized.status, 200);
  const result = (await authorized.json()) as { status: string; output: string };
  assert.equal(result.status, 'success');
  assert.equal(result.output, 'Served.');

  // The shape AgentCore Runtime documents: `status` required, `time_of_last_update`
  // optional and only ever the moment the status last changed.
  const ping = await fetch(`${running.url}/ping`);
  assert.equal(ping.status, 200);
  const health = (await ping.json()) as { status: string; time_of_last_update: number };
  assert.equal(health.status, 'Healthy');
  assert.ok(Number.isInteger(health.time_of_last_update));
  const again = (await (await fetch(`${running.url}/ping`)).json()) as {
    time_of_last_update: number;
  };
  // Unchanged between probes: a timestamp that advanced every time would read as a
  // status that never settles, and the idle session timeout would never fire.
  assert.equal(again.time_of_last_update, health.time_of_last_update);

  const logs = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const invocationStart = logs.find(
    (entry) =>
      entry.event === 'invocation.started' && entry.runtimeSessionId === 'runtime-session-1',
  );
  assert.ok(invocationStart);
  assert.equal(invocationStart.traceId, 'Root=trace-1');
  assert.equal(invocationStart.requestId, invocationStart.invocationId);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === 'http.request.completed' &&
        entry.invocationId === invocationStart.invocationId &&
        entry.statusCode === 200,
    ),
  );
  assert.doesNotMatch(logLines.join('\n'), /x-agent-service-key:secret/);
});

test('a malformed payload is a 400 from the server, not a 500', async (t) => {
  const running = await startHeadlessServer({ host: '127.0.0.1', port: 0, serviceKey: 'secret' });
  t.after(() => running.close());

  const response = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-service-key': 'secret' },
    body: JSON.stringify({ prompt: 'Go.' }),
  });
  assert.equal(response.status, 400);
  const failure = (await response.json()) as { error: string };
  assert.match(failure.error, /Invalid invocation payload/);
});

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentEvent } from '../../src/index.js';
import {
  AgentHarnessError,
  createBuiltinTools,
  InMemoryArtifactStore,
  InMemorySessionStore,
  InMemoryContentStore,
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

/**
 * A shell command that prints and then keeps running.
 *
 * The runtime's tool catalogue is fixed (`AGENT_RUNTIME_SUPPORT.tools`), so a test
 * cannot invent a tool to observe; it uses the real shell tool, which already
 * reports every output chunk. The gap between the print and the exit is what makes
 * live progress distinguishable from progress flushed at the end.
 */
const SLOW_SHELL =
  process.platform === 'win32'
    ? {
        tool: 'powershell',
        command: "Write-Output 'step one'; Start-Sleep -Milliseconds 700",
        options: { powershell: true },
      }
    : {
        tool: 'bash',
        command: "echo 'step one'; sleep 0.7",
        options: { powershell: false },
      };

function shellPayload(baseURL: string, prompt: string): InvocationPayloadInput {
  return payload(baseURL, {
    prompt,
    agent: {
      name: 'shell-demo',
      systemPrompt: 'You run shell commands.',
      tools: [SLOW_SHELL.tool],
      limits: { maxTurns: 4 },
    },
    permissionRules: [{ tool: SLOW_SHELL.tool, decision: 'allow' as const }],
  });
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

test('client history recovers a missing session once and never duplicates a stored session', async (t) => {
  const endpoint = await scriptedEndpoint([
    textChunk('First answer.'),
    textChunk('Second answer.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-session-recovery-'));
  const sessionStore = new InMemorySessionStore();
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const options = {
    workspaceRoot,
    sessionStore,
    builtinToolOptions: { powershell: false },
  } as const;
  const recovered = await invokeHeadless(
    payload(endpoint.baseURL, {
      sessionId: 'recoverable-session',
      session: {
        mode: 'persistent',
        history: [
          { id: 'old-user', role: 'user', content: 'Earlier question.' },
          { id: 'old-assistant', role: 'assistant', content: 'Earlier answer.' },
        ],
      },
      prompt: 'Continue once.',
    }),
    options,
  );
  assert.equal(recovered.session.origin, 'client_history');
  assert.equal(recovered.session.resumed, true);
  assert.match(JSON.stringify(endpoint.requests[0]), /Earlier question/);

  const resumed = await invokeHeadless(
    payload(endpoint.baseURL, {
      sessionId: 'recoverable-session',
      session: {
        mode: 'persistent',
        history: [{ id: 'ignored', role: 'user', content: 'MUST NOT BE APPENDED' }],
      },
      prompt: 'Continue twice.',
    }),
    options,
  );
  assert.equal(resumed.session.origin, 'store');
  assert.equal(resumed.session.resumed, true);
  assert.equal(JSON.stringify(endpoint.requests[1]).includes('MUST NOT BE APPENDED'), false);
  assert.match(JSON.stringify(endpoint.requests[1]), /First answer/);
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

test('a Markdown artifact keeps accompanying chat text with the file response', async (t) => {
  const markdown = '# Launch plan\n\nShip the first release.';
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-doc', 'create_markdown_artifact', {
      title: 'Launch plan',
      filename: '../Launch plan',
      content: markdown,
    }),
    textChunk('I created the requested document.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-artifact-'));
  const artifactStore = new InMemoryArtifactStore();
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(
    payload(endpoint.baseURL, {
      prompt: 'Create a Markdown launch-plan document.',
      agent: {
        name: 'document-demo',
        systemPrompt: 'Use the artifact tool for requested documents.',
        // Response-presentation tools are injected even when operational tools are
        // explicitly restricted.
        tools: [],
        limits: { maxTurns: 4 },
      },
      includeEvents: true,
    }),
    { workspaceRoot, artifactStore, builtinToolOptions: { powershell: false } },
  );

  assert.equal(result.output, 'I created the requested document.');
  assert.equal(result.response.type, 'files');
  assert.equal(result.artifacts.length, 1);
  const artifact = result.artifacts[0]!;
  assert.equal(artifact.contentType, 'text/markdown; charset=utf-8');
  assert.equal(artifact.metadata.filename, 'Launch-plan.md');
  assert.equal(await artifactStore.get(artifact.id), markdown);
  assert.ok(result.events?.some((event) => event.type === 'artifact.created'));
});

test('a streamed Markdown artifact keeps the model confirmation message', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-stream-doc', 'create_markdown_artifact', {
      title: 'Streamed notes',
      filename: 'streamed-notes.md',
      content: '# Streamed notes',
    }),
    textChunk('I created the requested document.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-stream-artifact-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const events: AgentEvent[] = [];
  for await (const event of streamHeadless(
    payload(endpoint.baseURL, {
      prompt: 'Create a Markdown notes document.',
      agent: {
        name: 'stream-document-demo',
        systemPrompt: 'Use the artifact tool for requested documents.',
        tools: [],
        limits: { maxTurns: 4 },
      },
    }),
    {
      workspaceRoot,
      artifactStore: new InMemoryArtifactStore(),
      builtinToolOptions: { powershell: false },
    },
  )) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === 'artifact.created'));
  assert.equal(
    events.some(
      (event) =>
        event.type === 'assistant.text.delta' && event.delta.includes('I created the requested'),
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'assistant.message.completed' &&
        event.message.content.some(
          (block) => block.type === 'text' && block.text.includes('I created the requested'),
        ),
    ),
    true,
  );
});

test('the HTTP server downloads stored artifacts with their Markdown filename', async (t) => {
  const artifactStore = new InMemoryArtifactStore();
  const artifact = await artifactStore.put('# Notes', {
    contentType: 'text/markdown; charset=utf-8',
    metadata: { filename: 'notes.md', presentation: 'file' },
  });
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    serviceKey: 'artifact-test-key',
    artifactStore,
  });
  t.after(() => running.close());

  const response = await fetch(`${running.url}/artifacts/${artifact.id}`, {
    headers: { 'x-agent-service-key': 'artifact-test-key' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="notes.md"');
  assert.equal(await response.text(), '# Notes');
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
  const expectedOrder = [
    'invocation.started',
    'invocation.payload.validated',
    'invocation.preparation.started',
    'agent.resolution.started',
    'agent.resolution.completed',
    'invocation.preparation.completed',
    'session.started',
    'model.request.started',
    'tool.execution.started',
    'tool.execution.completed',
    'output.completed',
    'invocation.cleanup.completed',
    'invocation.completed',
  ];
  let previous = -1;
  for (const event of expectedOrder) {
    const index = events.indexOf(event, previous + 1);
    assert.ok(index > previous, `${event} is missing or out of order`);
    previous = index;
  }
  assert.ok(events.includes('model.attempt.started'));
  assert.equal(events.at(-1), 'invocation.completed');
  assert.ok(
    events.indexOf('invocation.cleanup.completed') < events.indexOf('invocation.completed'),
  );
  assert.ok(records.every((record) => record.invocationId === 'invocation-logged'));
  assert.ok(records.every((record) => typeof record.message === 'string'));
  assert.ok(records.every((record) => record.schemaVersion === 1));
  assert.deepEqual(
    records.map((record) => record.logSequence),
    records.map((_, index) => index + 1),
  );

  const start = records[0] as {
    payloadSummary: { agentName: string; modelProvider: string; promptChars: number };
  };
  assert.equal(start.payloadSummary.agentName, 'payload-demo');
  assert.equal(start.payloadSummary.modelProvider, 'local-fake');
  assert.ok(start.payloadSummary.promptChars > 0);
  assert.equal('payload' in start, false);
  assert.equal(events.includes('invocation.payload.received'), false);
  assert.equal(events.includes('assistant.text.delta'), false);
  assert.equal(events.includes('tool.input.delta'), false);
  assert.equal(events.includes('tool.requested'), false);
  assert.equal(events.includes('run.preparing'), false);
  assert.doesNotMatch(lines.join('\n'), /Write hello\.txt with the text/);
  assert.doesNotMatch(lines.join('\n'), /test-key/);

  const modelStarted = records.find((record) => record.event === 'model.request.started');
  assert.ok(modelStarted);
  assert.equal(typeof modelStarted.toolCount, 'number');
  assert.equal('toolNames' in modelStarted, false);
  const agentResolved = records.find((record) => record.event === 'agent.resolution.completed');
  assert.ok(agentResolved);
  assert.equal(typeof agentResolved.toolCount, 'number');
  assert.equal('tools' in agentResolved, false);

  const completed = records.at(-1) as {
    outputChars: number;
    usage: { inputTokens: number; outputTokens: number };
  };
  assert.equal(completed.outputChars, result.output.length);
  assert.equal(completed.usage.inputTokens, 120);
  assert.equal(completed.usage.outputTokens, 30);
});

test('skill loading is a correlated milestone in the end-to-end tool lifecycle', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-skill', 'skill', { name: 'logging-guide' }),
    toolCallChunk('call-write', 'write_file', { path: 'guided.txt', content: 'guided' }),
    textChunk('Loaded the guide and wrote guided.txt.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-skill-logged-'));
  const lines: string[] = [];
  const instructions = 'Use write_file to create the requested file.';
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const result = await invokeHeadless(
    payload(endpoint.baseURL, {
      prompt: 'Load the logging guide and create guided.txt.',
      agent: {
        name: 'skill-log-demo',
        systemPrompt: 'Load the named skill before writing.',
        tools: ['write_file'],
        limits: { maxTurns: 5 },
      },
      skills: [{ name: 'logging-guide', uri: 's3://agent-skills/logging/SKILL.md' }],
      permissionRules: [
        { tool: 'skill', decision: 'allow' },
        { tool: 'write_file', decision: 'allow' },
      ],
    }),
    {
      invocationId: 'invocation-skill-logged',
      workspaceRoot,
      builtinToolOptions: { powershell: false },
      skillContentStore: new InMemoryContentStore({
        'logging/SKILL.md': [
          '---',
          'description: Logging workflow',
          'allowedTools: write_file',
          '---',
          instructions,
        ].join('\n'),
      }),
      logSink: new StructuredLogSink((line) => lines.push(line)),
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(await readFile(path.join(result.workingDirectory, 'guided.txt'), 'utf8'), 'guided');
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const indexOf = (
    event: string,
    predicate: (record: Record<string, unknown>) => boolean = () => true,
  ) => records.findIndex((record) => record.event === event && predicate(record));
  const materialized = indexOf('skill.materialization.completed');
  const skillToolStarted = indexOf(
    'tool.execution.started',
    (record) => record.toolName === 'skill',
  );
  const skillLoaded = indexOf('skill.load.completed');
  const writeStarted = indexOf(
    'tool.execution.started',
    (record) => record.toolName === 'write_file',
  );
  const outputCompleted = indexOf('output.completed');
  assert.ok(materialized >= 0);
  assert.ok(materialized < skillToolStarted);
  assert.ok(skillToolStarted < skillLoaded);
  assert.ok(skillLoaded < writeStarted);
  assert.ok(writeStarted < outputCompleted);

  const loaded = records[skillLoaded];
  assert.equal(loaded?.skillName, 'logging-guide');
  assert.equal(loaded?.toolCallId, 'call-skill');
  assert.equal(loaded?.invocationId, 'invocation-skill-logged');
  assert.equal(JSON.stringify(records).includes(instructions), false);
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

  // Preparation reports before the session exists, so the first thing a caller
  // sees is what the run is doing rather than nothing at all.
  assert.equal(types[0], 'run.preparing');
  assert.ok(types.includes('session.started'));
  assert.ok(types.includes('assistant.text.delta'));
  assert.equal(types.at(-1), 'session.completed');
});

test('an S3-referenced skill is downloaded, materialized, and deleted on close', async (t) => {
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
        uri: 's3://agent-skills/review/abap/SKILL.md',
      },
    ],
  });

  const document = [
    '---',
    'description: Checklist for reviewing an ABAP change',
    'allowedTools: read_file',
    '---',
    'Read the object, then check for hardcoded clients.',
  ].join('\n');

  const agent = await resolveInlineAgent(parsed, {
    localTools: createBuiltinTools(runtime, { powershell: false }),
    skillContentStore: new InMemoryContentStore({
      'review/abap/SKILL.md': document,
    }),
  });

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
  assert.equal(onDisk, document);
  // Limits derived from the provider's defaults: the window less the reply.
  assert.equal(agent.limits.maxOutputTokens, 8_192);
  assert.equal(agent.limits.maxInputTokens, 200_000 - 8_192);

  const skillDirectory = agent.skillDirectory;
  await agent.close();
  assert.equal(existsSync(skillDirectory), false);
});

test('the strict skill payload accepts a URI and rejects an inlined document', () => {
  const base = {
    prompt: 'Review it.',
    agent: { name: 'reviewer', systemPrompt: 'You review code.', tools: ['read_file'] },
    modelProvider: {
      name: 'local-fake',
      provider: 'openai-compatible' as const,
      model: 'fake-model',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
    },
  };

  assert.equal(
    parseInvocationPayload({
      ...base,
      skills: [{ name: 'abap-review', uri: 's3://agent-skills/review/SKILL.md' }],
    }).skills[0]?.uri,
    's3://agent-skills/review/SKILL.md',
  );
  assert.throws(() =>
    parseInvocationPayload({
      ...base,
      skills: [{ name: 'abap-review', document: '# Legacy inline body' }],
    }),
  );
  assert.throws(() =>
    parseInvocationPayload({
      ...base,
      skills: [{ name: 'abap-review', uri: 'file:///tmp/SKILL.md' }],
    }),
  );
});

test('abandoning a stream during a skill download still removes its temp directory', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-skill-cancel-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseDownload: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  class DelayedContentStore extends InMemoryContentStore {
    override async load(key: string) {
      markStarted?.();
      await released;
      return super.load(key);
    }
  }

  const before = new Set(
    readdirSync(tmpdir()).filter((entry) => entry.startsWith('agent-harness-skills-')),
  );
  const stream = streamHeadless(
    payload('http://127.0.0.1:1/v1', {
      prompt: 'Review it.',
      agent: {
        name: 'cancelled-reviewer',
        systemPrompt: 'You review code.',
        tools: ['read_file'],
      },
      skills: [{ name: 'review', uri: 's3://agent-skills/review/SKILL.md' }],
    }),
    {
      workspaceRoot,
      builtinToolOptions: { powershell: false },
      skillContentStore: new DelayedContentStore({
        'review/SKILL.md': 'Review the code carefully.',
      }),
    },
  );

  await stream.next();
  await stream.next();
  await stream.next();
  await started;

  // `return` enters the generator's finally while preparation is still blocked.
  // Releasing it afterwards reproduces the race that used to orphan the directory.
  const closing = stream.return(undefined);
  releaseDownload?.();
  await closing;

  const added = readdirSync(tmpdir()).filter(
    (entry) => entry.startsWith('agent-harness-skills-') && !before.has(entry),
  );
  assert.deepEqual(added, []);
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

test('an abrupt SSE disconnect removes the materialized skill directory', async (t) => {
  const modelServer = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Drain the model request before starting its response.
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => {
        if (!response.destroyed) response.end(`${textChunk('Late answer.')}data: [DONE]\n\n`);
      }, 200).unref?.();
    })();
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const modelPort = (modelServer.address() as AddressInfo).port;
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-disconnect-'));
  const skillName = `disconnect_cleanup_${process.pid}`;
  const skillKey = 'disconnect/SKILL.md';
  const logLines: string[] = [];
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    workspaceRoot,
    builtinToolOptions: { powershell: false },
    skillContentStore: new InMemoryContentStore({
      [skillKey]: 'Review the request before continuing.',
    }),
    logSink: new StructuredLogSink((line) => logLines.push(line)),
  });
  t.after(async () => {
    await running.close();
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  let skillDirectory: string | undefined;
  await new Promise<void>((resolve, reject) => {
    let received = '';
    let disconnected = false;
    const deadline = setTimeout(
      () => reject(new Error('The streamed run never reached session.started')),
      3_000,
    );
    deadline.unref?.();
    const request = httpRequest(
      `${running.url}/invocations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += chunk;
          if (disconnected || !received.includes('event: session.started')) return;

          skillDirectory = readdirSync(tmpdir())
            .filter((entry) => entry.startsWith('agent-harness-skills-'))
            .map((entry) => path.join(tmpdir(), entry))
            .find((directory) => existsSync(path.join(directory, skillName, 'SKILL.md')));
          if (!skillDirectory) {
            clearTimeout(deadline);
            reject(new Error('The skill was not materialized before the session started'));
            return;
          }

          disconnected = true;
          clearTimeout(deadline);
          response.destroy();
          resolve();
        });
        response.on('error', (error) => {
          if (!disconnected) reject(error);
        });
      },
    );
    request.on('error', (error) => {
      if (!disconnected) reject(error);
    });
    request.end(
      JSON.stringify(
        payload(`http://127.0.0.1:${modelPort}/v1`, {
          prompt: 'Use the review skill.',
          skills: [{ name: skillName, uri: `s3://agent-skills/${skillKey}` }],
          permissionRules: [{ tool: 'skill', decision: 'allow' }],
        }),
      ),
    );
  });

  assert.ok(skillDirectory);
  const cleanupDeadline = Date.now() + 3_000;
  while (existsSync(skillDirectory) && Date.now() < cleanupDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(skillDirectory), false, 'the disconnected stream leaked its skill files');
  assert.ok(
    logLines.some((line) => JSON.parse(line).event === 'http.request.disconnected'),
    'the server did not observe the abrupt disconnect',
  );
});

test('payload.stream picks the encoding only when the transport did not', async (t) => {
  const endpoint = await scriptedEndpoint([
    textChunk('One.'),
    textChunk('Two.'),
    textChunk('Three.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-prefer-'));
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    workspaceRoot,
    builtinToolOptions: { powershell: false },
  });
  t.after(async () => {
    await running.close();
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const post = (body: InvocationPayloadInput, accept?: string) =>
    fetch(`${running.url}/invocations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accept === undefined ? {} : { accept }),
      },
      body: JSON.stringify(body),
    });

  // `fetch` sends `Accept: */*`, which states nothing, so the payload decides.
  const preferred = await post(payload(endpoint.baseURL, { prompt: 'Say one.', stream: true }));
  assert.equal(preferred.status, 200);
  assert.match(preferred.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(await preferred.text(), /event: session\.completed/);

  // The caller said what it can read, and a body does not get to override that.
  const overridden = await post(
    payload(endpoint.baseURL, { prompt: 'Say two.', stream: true }),
    'application/json',
  );
  assert.equal(overridden.status, 200);
  assert.match(overridden.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(((await overridden.json()) as { status: string }).status, 'success');

  // And the transport can still ask for a stream a payload never mentioned.
  const asked = await post(
    payload(endpoint.baseURL, { prompt: 'Say three.' }),
    'text/event-stream',
  );
  assert.match(asked.headers.get('content-type') ?? '', /text\/event-stream/);
});

test('tool progress reaches the stream while the tool is still running', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-1', SLOW_SHELL.tool, { command: SLOW_SHELL.command }),
    textChunk('Done.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-progress-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const events: Array<{ event: AgentEvent; at: number }> = [];
  for await (const event of streamHeadless(
    shellPayload(endpoint.baseURL, 'Run the slow command.'),
    { workspaceRoot, builtinToolOptions: SLOW_SHELL.options },
  )) {
    events.push({ event, at: Date.now() });
  }

  const firstProgress = events.find(({ event }) => event.type === 'tool.progress');
  const completed = events.find(({ event }) => event.type === 'tool.completed');
  assert.ok(firstProgress, 'the shell tool reported nothing');
  assert.ok(completed);

  // The command prints immediately and then sleeps 700ms. Buffered progress would
  // arrive with the result; live progress arrives while the command is sleeping,
  // so the gap between the two is the whole point.
  const gap = completed.at - firstProgress.at;
  assert.ok(gap > 200, `progress arrived only ${gap}ms before the result, so it was buffered`);

  // One run, one sequence: the preparation events and the session's own share a
  // counter, which is what a resuming caller relies on.
  const sequences = events.map(({ event }) => event.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_value, index) => index + 1),
  );
});

test('preparation is reported before the session starts', async (t) => {
  const endpoint = await scriptedEndpoint([textChunk('Ready.')]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-prep-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const events: AgentEvent[] = [];
  for await (const event of streamHeadless(payload(endpoint.baseURL, { prompt: 'Say ready.' }), {
    workspaceRoot,
    builtinToolOptions: { powershell: false },
  })) {
    events.push(event);
  }

  const stages = events
    .filter((event) => event.type === 'run.preparing')
    .map((event) => event.stage);
  assert.deepEqual(stages, ['workspace', 'agent', 'ready']);
  const firstPreparing = events.findIndex((event) => event.type === 'run.preparing');
  const sessionStarted = events.findIndex((event) => event.type === 'session.started');
  assert.equal(firstPreparing, 0);
  assert.ok(sessionStarted > firstPreparing);
});

test('a stream keeps the connection alive and can be resumed where it dropped', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-1', SLOW_SHELL.tool, { command: SLOW_SHELL.command }),
    textChunk('Done.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-resume-'));
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    workspaceRoot,
    builtinToolOptions: SLOW_SHELL.options,
    keepAliveMs: 30,
    resumableRuns: true,
  });
  t.after(async () => {
    await running.close();
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const body = JSON.stringify(shellPayload(endpoint.baseURL, 'Run the slow command.'));

  const first = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body,
  });
  assert.equal(first.status, 200);
  const runId = first.headers.get('x-run-id');
  assert.ok(runId, 'a registered stream names its run');

  // Read until the command has printed, then keep reading while it sleeps — long
  // enough for the 30ms keep-alive to fire on an otherwise silent stream.
  const reader = (first.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  let lastId = 0;
  while (!text.includes('step one') || !text.includes(': keep-alive')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('id: ')) lastId = Number.parseInt(line.slice(4), 10);
  }
  assert.ok(text.includes(': keep-alive'), 'a silent stream still writes comment frames');
  assert.ok(lastId > 0);

  // Drop the connection mid-run. The work continues without it.
  await reader.cancel().catch(() => undefined);

  const resumed = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-run-id': runId,
      'last-event-id': String(lastId),
    },
    body: '{}',
  });
  assert.equal(resumed.status, 200);
  const tail = await resumed.text();

  const resumedIds = [...tail.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(resumedIds.length > 0, 'the resumed stream replays what the first one missed');
  assert.equal(
    resumedIds.every((id) => id > lastId),
    true,
    'a resumed stream repeats nothing the caller already had',
  );
  assert.match(tail, /event: session\.completed/);
});

/** `write_file` has no per-invocation check and is not `kind: 'read'`, so with no
 * rule covering it the handler falls through to the fallback — which is the only
 * way to reach a permission question. */
function askingPayload(baseURL: string): InvocationPayloadInput {
  return payload(baseURL, {
    prompt: 'Write hello.txt.',
    agent: {
      name: 'ask-demo',
      systemPrompt: 'You write files when asked.',
      tools: ['write_file'],
      limits: { maxTurns: 4 },
    },
    permissionRules: [],
    permissionFallback: 'ask',
  });
}

test('an asking payload is refused unless the transport can answer it', async (t) => {
  const endpoint = await scriptedEndpoint([textChunk('Nothing to do.')]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-ask-'));
  t.after(async () => {
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // Buffered: nobody is watching, so a question would hang. Refused instead.
  await assert.rejects(
    async () =>
      invokeHeadless(askingPayload(endpoint.baseURL), {
        workspaceRoot,
        builtinToolOptions: { powershell: false },
      }),
    (error: unknown) =>
      error instanceof AgentHarnessError && error.code === 'INTERACTIVE_PERMISSIONS_UNAVAILABLE',
  );
});

test('a streamed run asks for permission and runs the tool once answered', async (t) => {
  const endpoint = await scriptedEndpoint([
    toolCallChunk('call-1', 'write_file', { path: 'hello.txt', content: 'hi' }),
    textChunk('Written.'),
  ]);
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'headless-answer-'));
  const running = await startHeadlessServer({
    host: '127.0.0.1',
    port: 0,
    workspaceRoot,
    builtinToolOptions: { powershell: false },
    resumableRuns: true,
  });
  t.after(async () => {
    await running.close();
    await endpoint.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const response = await fetch(`${running.url}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(askingPayload(endpoint.baseURL)),
  });
  assert.equal(response.status, 200);
  const runId = response.headers.get('x-run-id');
  assert.ok(runId);

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: permission.requested')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false, 'the run ended without asking');
    text += decoder.decode(chunk.value, { stream: true });
  }
  const asked = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as AgentEvent)
    .find((event) => event.type === 'permission.requested');
  assert.ok(asked && asked.type === 'permission.requested');
  assert.equal(asked.toolName, 'write_file');

  const answer = await fetch(`${running.url}/invocations/permissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, requestId: asked.requestId, decision: 'allow' }),
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), {
    answered: true,
    runId,
    requestId: asked.requestId,
    decision: 'allow',
  });

  while (!text.includes('event: session.completed')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(text, /event: permission\.resolved/);
  // Allowed, so the tool ran rather than coming back as a denial.
  assert.match(text, /event: tool\.completed/);
  assert.doesNotMatch(text, /Permission denied/);

  // A second answer to the same question has nothing left to resolve.
  const repeat = await fetch(`${running.url}/invocations/permissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, requestId: asked.requestId, decision: 'allow' }),
  });
  assert.equal(repeat.status, 409);
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

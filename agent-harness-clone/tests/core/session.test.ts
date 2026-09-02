import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  isSerializableEvent,
  ScriptedModelProvider,
  type AgentEvent,
  type HarnessLogEntry,
  type Tool,
} from '../../src/index.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test('streams a plain response with serializable lifecycle events', async () => {
  const provider = new ScriptedModelProvider([
    [
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      {
        type: 'usage',
        usage: { inputTokens: 2, outputTokens: 2 },
      },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({ provider });
  const events = await collect(session.run({ prompt: 'Hello' }));

  assert.deepEqual(
    events.filter((event) => event.type === 'assistant.text.delta').map((event) => event.delta),
    ['Hello ', 'world'],
  );
  assert.equal(events.at(-1)?.type, 'session.completed');
  assert.ok(events.every(isSerializableEvent));
  assert.equal(session.messages.length, 2);
});

test('executes a tool and returns its result to the next model request', async () => {
  const inputSchema = z.object({ value: z.string() });
  const echoTool: Tool<z.infer<typeof inputSchema>> = {
    name: 'echo',
    description: 'Echo a value',
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      return { content: input.value };
    },
  };
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'call-1', name: 'echo', input: { value: 'done' } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    (request) => {
      const last = request.messages.at(-1);
      assert.equal(last?.content[0]?.type, 'tool_result');
      return [
        { type: 'text_delta' as const, delta: 'Tool completed' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const session = createAgentSession({
    provider,
    tools: [echoTool],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'Use echo' }));

  assert.ok(events.some((event) => event.type === 'tool.started'));
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.completed' && event.result.content === 'done' && !event.result.isError,
    ),
  );
});

test('returns invalid tool input as a controlled tool error', async () => {
  const logs: HarnessLogEntry[] = [];
  const inputSchema = z.object({ value: z.string() });
  const tool: Tool<z.infer<typeof inputSchema>> = {
    name: 'strict_tool',
    description: 'Requires a string',
    inputSchema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      return { content: input.value };
    },
  };
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'bad-call', name: 'strict_tool', input: { value: 1 } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      { type: 'text_delta', delta: 'Recovered' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({
    provider,
    tools: [tool],
    logSink: { log: (entry) => logs.push(structuredClone(entry)) },
  });
  const events = await collect(session.run({ prompt: 'Call it' }));
  const completed = events.find(
    (event) => event.type === 'tool.completed' && event.result.toolCallId === 'bad-call',
  );
  assert.equal(completed?.type, 'tool.completed');
  if (completed?.type === 'tool.completed') assert.equal(completed.result.isError, true);
  const failed = logs.find(
    (entry) => entry.event === 'tool.execution.failed' && entry.toolCallId === 'bad-call',
  );
  assert.ok(failed);
  assert.equal(failed.toolName, 'strict_tool');
  assert.equal(failed.failureStage, 'validation');
  assert.equal(failed.code, 'INVALID_TOOL_INPUT');
  assert.equal(failed.outcome, 'failure');
  assert.equal(
    logs.some(
      (entry) => entry.event === 'tool.execution.started' && entry.toolCallId === 'bad-call',
    ),
    false,
  );
});

test('terminates at the configured maximum turn count', async () => {
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'unknown', name: 'missing', input: {} },
      { type: 'completed', stopReason: 'tool_use' },
    ],
  ]);
  const session = createAgentSession({ provider, limits: { maxTurns: 1 } });
  const events = await collect(session.run({ prompt: 'Loop' }));
  assert.ok(
    events.some((event) => event.type === 'session.completed' && event.reason === 'max_turns'),
  );
});

test('runs consecutive concurrency-safe tools in parallel', async () => {
  const schema = z.object({ value: z.string() });
  const delayed: Tool<z.infer<typeof schema>> = {
    name: 'delayed',
    description: 'Delayed read',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { content: input.value };
    },
  };
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'tool_call', id: 'one', name: 'delayed', input: { value: 'one' } },
        { type: 'tool_call', id: 'two', name: 'delayed', input: { value: 'two' } },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [delayed],
    contextIntelligence: false,
  });
  const started = performance.now();
  await collect(session.run({ prompt: 'parallel' }));
  assert.ok(performance.now() - started < 145);
  const toolResults = session.messages[2]?.content;
  assert.deepEqual(
    toolResults?.map((block) => (block.type === 'tool_result' ? block.content : '')),
    ['one', 'two'],
  );
});

test('interrupts an active model stream and closes with a cancelled reason', async () => {
  const provider = {
    name: 'slow',
    async *stream(request: import('../../src/index.js').ModelRequest) {
      yield { type: 'text_delta' as const, delta: 'started' };
      if (request.signal.aborted) throw new Error('aborted');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (request.signal.aborted) throw new Error('aborted');
      yield { type: 'completed' as const, stopReason: 'end_turn' as const };
    },
  };
  const session = createAgentSession({ provider });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'wait' })) {
    events.push(event);
    if (event.type === 'assistant.text.delta') session.interrupt('test');
  }
  assert.ok(
    events.some((event) => event.type === 'session.completed' && event.reason === 'cancelled'),
  );
});

test('surfaces an asynchronous permission request and accepts a controller response', async () => {
  let executed = false;
  const schema = z.object({ value: z.string() });
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'mutate',
    description: 'Mutating operation',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'write',
    concurrencySafe: false,
    async execute({ value }) {
      executed = true;
      return { content: value };
    },
  };
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'tool_call', id: 'mutation', name: 'mutate', input: { value: 'ok' } },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'approved' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [tool],
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'mutate' })) {
    events.push(event);
    if (event.type === 'permission.requested') {
      assert.equal(session.respondToPermission(event.requestId, 'allow'), true);
    }
  }
  assert.equal(executed, true);
  assert.ok(events.some((event) => event.type === 'permission.resolved'));
});

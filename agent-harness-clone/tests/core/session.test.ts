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

test('forces a tool-less synthesis turn when the turn budget runs out mid-tool-use', async () => {
  let synthesisRequestToolCount: number | undefined;
  let synthesisSystemPrompt: string | undefined;
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'unknown', name: 'missing', input: {} },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    (request) => {
      synthesisRequestToolCount = request.tools.length;
      synthesisSystemPrompt = request.systemPrompt;
      return [
        { type: 'text_delta', delta: 'Based on what I found: 42.' },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
  const session = createAgentSession({ provider, limits: { maxTurns: 1 } });
  const events = await collect(session.run({ prompt: 'Loop' }));

  // The forced call offered no tools at all — a hard stop, not a hopeful one —
  // and named the situation in the system prompt so the model knows why.
  assert.equal(synthesisRequestToolCount, 0);
  assert.match(synthesisSystemPrompt ?? '', /all available turns/);

  const finalText = events
    .filter((event) => event.type === 'assistant.text.delta')
    .map((event) => event.delta)
    .join('');
  assert.equal(finalText, 'Based on what I found: 42.');

  // One completed message for the exhausted tool-use turn, one more for the
  // forced synthesis call — and the last one is the coherent final answer.
  const completedMessages = events.filter((event) => event.type === 'assistant.message.completed');
  assert.equal(completedMessages.length, 2);
  const lastMessage = completedMessages.at(-1);
  assert.equal(
    lastMessage?.type === 'assistant.message.completed' &&
      lastMessage.message.content[0]?.type === 'text' &&
      lastMessage.message.content[0].text,
    'Based on what I found: 42.',
  );

  assert.ok(
    events.some((event) => event.type === 'session.completed' && event.reason === 'max_turns'),
  );
  assert.ok(events.every(isSerializableEvent));
});

test('a synthesis attempt that itself fails does not mask the max_turns ending', async () => {
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'unknown', name: 'missing', input: {} },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    // No second script entry: ScriptedModelProvider throws SCRIPT_EXHAUSTED on
    // the forced synthesis call, exercising forceSynthesis()'s own catch path.
  ]);
  const session = createAgentSession({ provider, limits: { maxTurns: 1 } });
  const events = await collect(session.run({ prompt: 'Loop' }));

  // Only the exhausted turn's tool-call message completes; the failed
  // synthesis attempt adds no second message, but the run still ends cleanly.
  assert.equal(events.filter((event) => event.type === 'assistant.message.completed').length, 1);
  assert.ok(
    events.some((event) => event.type === 'session.completed' && event.reason === 'max_turns'),
  );
});

test("strips leaked tool-call template syntax from a normal turn's text", async () => {
  const provider = new ScriptedModelProvider([
    [
      {
        type: 'text_delta',
        delta:
          'The answer is 42. <|tool_calls_section_begin|> <|tool_call_begin|> ' +
          'functions.browser_use:20 <|tool_call_argument_begin|> {"action": "navigate"}',
      },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({ provider });
  const events = await collect(session.run({ prompt: 'What is the answer?' }));

  const completed = events.find((event) => event.type === 'assistant.message.completed');
  assert.equal(completed?.type, 'assistant.message.completed');
  const textBlock =
    completed?.type === 'assistant.message.completed' ? completed.message.content[0] : undefined;
  assert.equal(textBlock?.type === 'text' ? textBlock.text : undefined, 'The answer is 42.');
});

test('strips leaked tool-call template syntax from a forced synthesis answer', async () => {
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'unknown', name: 'missing', input: {} },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      {
        type: 'text_delta',
        delta:
          'Spider-Man films have grossed over $13 billion worldwide. ' +
          '<|tool_calls_section_begin|> <|tool_call_begin|> functions.browser_use:20',
      },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({ provider, limits: { maxTurns: 1 } });
  const events = await collect(session.run({ prompt: 'Loop' }));

  const completedMessages = events.filter((event) => event.type === 'assistant.message.completed');
  const lastMessage = completedMessages.at(-1);
  const textBlock =
    lastMessage?.type === 'assistant.message.completed'
      ? lastMessage.message.content[0]
      : undefined;
  assert.equal(
    textBlock?.type === 'text' ? textBlock.text : undefined,
    'Spider-Man films have grossed over $13 billion worldwide.',
  );
});

test('announces the turn budget in the system prompt by default', async () => {
  const seenPrompts: (string | undefined)[] = [];
  const provider = new ScriptedModelProvider([
    (request) => {
      seenPrompts.push(request.systemPrompt);
      return [
        { type: 'tool_call', id: 'unknown', name: 'missing', input: {} },
        { type: 'completed', stopReason: 'tool_use' },
      ];
    },
    (request) => {
      seenPrompts.push(request.systemPrompt);
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
  const session = createAgentSession({ provider, limits: { maxTurns: 5 } });
  await collect(session.run({ prompt: 'Loop' }));

  assert.match(seenPrompts[0] ?? '', /Turn 1 of 5 \(4 remaining\)\./);
  assert.match(seenPrompts[1] ?? '', /Turn 2 of 5 \(3 remaining\)\./);
});

test('omits the turn budget line when announceTurnBudget is disabled', async () => {
  let seenPrompt: string | undefined;
  const provider = new ScriptedModelProvider([
    (request) => {
      seenPrompt = request.systemPrompt;
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
  const session = createAgentSession({
    provider,
    limits: { maxTurns: 5 },
    announceTurnBudget: false,
    announceCurrentDate: false,
  });
  await collect(session.run({ prompt: 'Loop' }));

  assert.equal(seenPrompt, undefined);
});

test('announces the current date in the system prompt by default', async () => {
  let seenPrompt: string | undefined;
  const provider = new ScriptedModelProvider([
    (request) => {
      seenPrompt = request.systemPrompt;
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
  const clock = () => new Date('2026-08-29T12:00:00.000Z');
  const session = createAgentSession({ provider, clock, announceTurnBudget: false });
  await collect(session.run({ prompt: 'What day is it?' }));

  assert.match(seenPrompt ?? '', /Today's date: 2026-08-29 \(Saturday\)\./);
});

test('omits the current date line when announceCurrentDate is disabled', async () => {
  let seenPrompt: string | undefined;
  const provider = new ScriptedModelProvider([
    (request) => {
      seenPrompt = request.systemPrompt;
      return [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ];
    },
  ]);
  const session = createAgentSession({
    provider,
    announceTurnBudget: false,
    announceCurrentDate: false,
  });
  await collect(session.run({ prompt: 'Loop' }));

  assert.equal(seenPrompt, undefined);
});

test('short-circuits an exact repeat of a tool call that just failed', async () => {
  let executeCount = 0;
  const schema = z.object({ selector: z.string() });
  const flaky: Tool<z.infer<typeof schema>> = {
    name: 'flaky_click',
    description: 'Click something that may be blocked',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: false,
    async execute() {
      executeCount += 1;
      return { content: 'Timed out waiting for element', isError: true };
    },
  };
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'call-1', name: 'flaky_click', input: { selector: '#ok' } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      // Same tool, same input as call-1 — should be short-circuited, not re-run.
      { type: 'tool_call', id: 'call-2', name: 'flaky_click', input: { selector: '#ok' } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      { type: 'text_delta', delta: 'Giving up on that selector.' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({ provider, tools: [flaky], limits: { maxTurns: 10 } });
  const events = await collect(session.run({ prompt: 'Click it twice' }));

  assert.equal(executeCount, 1);
  const results = events.filter((event) => event.type === 'tool.completed') as Extract<
    AgentEvent,
    { type: 'tool.completed' }
  >[];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.result.toolCallId, 'call-1');
  assert.equal(results[1]?.result.toolCallId, 'call-2');
  assert.match(results[1]?.result.content ?? '', /already failed moments ago/);
  assert.match(results[1]?.result.content ?? '', /Timed out waiting for element/);
  assert.equal(results[1]?.result.isError, true);
});

test('does not short-circuit a repeated call once it has succeeded', async () => {
  let executeCount = 0;
  const schema = z.object({ selector: z.string() });
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'click',
    description: 'Click something',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: false,
    async execute() {
      executeCount += 1;
      return { content: 'ok' };
    },
  };
  const provider = new ScriptedModelProvider([
    [
      { type: 'tool_call', id: 'call-1', name: 'click', input: { selector: '#ok' } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      { type: 'tool_call', id: 'call-2', name: 'click', input: { selector: '#ok' } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    [
      { type: 'text_delta', delta: 'Clicked twice.' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ]);
  const session = createAgentSession({ provider, tools: [tool], limits: { maxTurns: 10 } });
  await collect(session.run({ prompt: 'Click it twice' }));

  // Neither call ever failed, so the guard never has grounds to intervene.
  assert.equal(executeCount, 2);
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

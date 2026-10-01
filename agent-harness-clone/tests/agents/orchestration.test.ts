import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  createTaskTool,
  createTodoWriteTool,
  DEFAULT_SUBAGENT_TYPES,
  isSerializableEvent,
  routeChildPermission,
  ScriptedModelProvider,
  type AgentEvent,
  type ModelRequest,
  type ModelStreamEvent,
  type SubagentHost,
  type Tool,
} from '../../src/index.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

const done = (text: string): ModelStreamEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'completed', stopReason: 'end_turn' },
];

const call = (id: string, name: string, input: unknown): ModelStreamEvent => ({
  type: 'tool_call',
  id,
  name,
  input,
});

function sleepTool(log: { active: number; peak: number }): Tool<{ ms: number }> {
  return {
    name: 'sleep',
    description: 'Sleep',
    inputSchema: z.object({ ms: z.number() }),
    jsonSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      log.active += 1;
      log.peak = Math.max(log.peak, log.active);
      await new Promise((resolve) => setTimeout(resolve, input.ms));
      log.active -= 1;
      return { content: `slept ${input.ms}` };
    },
  };
}

/**
 * A model that routes by the conversation it is given: the parent (whose system
 * prompt has no subagent contract) follows `parent`, and each child answers from
 * `child` based on its prompt. That mirrors how a real model would see these
 * separate contexts, and lets the parallel children consume responses in any
 * order.
 */
function routedProvider(options: {
  parent: ((request: ModelRequest, turn: number) => ModelStreamEvent[])[];
  child: (prompt: string, request: ModelRequest) => ModelStreamEvent[];
}) {
  let parentTurn = 0;
  const requests: ModelRequest[] = [];
  return {
    requests,
    provider: {
      name: 'routed',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        requests.push(request);
        const isChild = request.systemPrompt?.includes('You are a subagent') ?? false;
        const events = isChild
          ? options.child(firstUserText(request), request)
          : (options.parent[parentTurn++]?.(request, parentTurn) ?? done('parent exhausted'));
        for (const event of events) yield event;
      },
    },
  };
}

function firstUserText(request: ModelRequest): string {
  const first = request.messages.find((message) => message.role === 'user');
  return first?.content.find((block) => block.type === 'text')?.text ?? '';
}

function hostFor(
  provider:
    | ScriptedModelProvider
    | {
        name: string;
        stream: ModelRequest extends never
          ? never
          : (r: ModelRequest) => AsyncIterable<ModelStreamEvent>;
      },
  tools: Tool[],
  maxTurns = 6,
): SubagentHost {
  let n = 0;
  const host: SubagentHost = {
    parentSessionId: 'parent',
    children: new Map(),
    tools: () => tools,
    newId: () => String(++n),
    spawn: (spec) =>
      createAgentSession({
        sessionId: spec.taskId,
        provider,
        systemPrompt: spec.type.systemPrompt,
        tools: spec.tools,
        permissionHandler: new AllowAllPermissionHandler(),
        limits: { maxTurns },
        planOwner: spec.taskId,
      }),
  };
  return host;
}

test('independent subagents run concurrently and only their answers reach the parent', async () => {
  const log = { active: 0, peak: 0 };
  const tools = [sleepTool(log)];
  const routed = routedProvider({
    parent: [
      () => [
        call('t1', 'task', { description: 'Work A', prompt: 'do A', subagent_type: 'general' }),
        call('t2', 'task', { description: 'Work B', prompt: 'do B', subagent_type: 'general' }),
        call('t3', 'task', { description: 'Work C', prompt: 'do C', subagent_type: 'general' }),
        { type: 'completed', stopReason: 'tool_use' },
      ],
      () => done('All three done'),
    ],
    child: (prompt, request) =>
      request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
        ? done(`result of ${prompt}`)
        : [call(`s-${prompt}`, 'sleep', { ms: 60 }), { type: 'completed', stopReason: 'tool_use' }],
  });
  const host = hostFor(routed.provider, tools);
  const session = createAgentSession({
    provider: routed.provider,
    tools: [...tools, createTaskTool(host, { maxConcurrent: 4 })],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'Build A, B and C' }));

  assert.ok(events.every(isSerializableEvent));
  // The children's tools overlapped in time: the wave really ran in parallel.
  assert.equal(log.peak, 3);
  const started = events.filter((e) => e.type === 'subagent.started');
  const completed = events.filter((e) => e.type === 'subagent.completed');
  assert.equal(started.length, 3);
  assert.equal(completed.length, 3);
  assert.ok(completed.every((e) => e.type === 'subagent.completed' && e.status === 'completed'));
  assert.ok(events.some((e) => e.type === 'subagent.progress' && e.kind === 'tool.started'));

  // Context isolation: the parent's second request carries each child's final
  // answer, and none of the children's own tool traffic.
  const parentSecond = routed.requests.filter(
    (r) => !r.systemPrompt?.includes('You are a subagent'),
  )[1];
  assert.ok(parentSecond);
  const results = parentSecond.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_result')
    .map((b) => (b.type === 'tool_result' ? b.content : ''));
  assert.equal(results.length, 3);
  assert.ok(results.some((r) => r.includes('<task_result>\nresult of do A\n</task_result>')));
  assert.ok(!JSON.stringify(parentSecond.messages).includes('slept 60'));

  // Children never get delegation or the plan tool.
  const childRequest = routed.requests.find((r) => r.systemPrompt?.includes('You are a subagent'));
  assert.ok(childRequest);
  assert.ok(!childRequest.tools.some((t) => t.name === 'task' || t.name === 'todo_write'));
});

test('the concurrency cap queues a wide wave instead of failing it', async () => {
  const log = { active: 0, peak: 0 };
  const tools = [sleepTool(log)];
  const routed = routedProvider({
    parent: [
      () => [
        ...['a', 'b', 'c', 'd'].map((x) =>
          call(`t-${x}`, 'task', { description: x, prompt: x, subagent_type: 'general' }),
        ),
        { type: 'completed', stopReason: 'tool_use' },
      ],
      () => done('ok'),
    ],
    child: (prompt, request) =>
      request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
        ? done(prompt)
        : [call(`s-${prompt}`, 'sleep', { ms: 40 }), { type: 'completed', stopReason: 'tool_use' }],
  });
  const session = createAgentSession({
    provider: routed.provider,
    tools: [...tools, createTaskTool(hostFor(routed.provider, tools), { maxConcurrent: 2 })],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'four things' }));
  assert.equal(log.peak, 2);
  assert.equal(events.filter((e) => e.type === 'subagent.completed').length, 4);
});

test('a dependent wave runs after the first one and receives its result', async () => {
  const order: string[] = [];
  const routed = routedProvider({
    parent: [
      () => [
        call('w1', 'task', { description: 'Backend', prompt: 'backend', subagent_type: 'general' }),
        { type: 'completed', stopReason: 'tool_use' },
      ],
      (request) => {
        const prior = JSON.stringify(request.messages);
        assert.ok(prior.includes('API is /v1/items'), 'wave 2 is planned from wave 1 output');
        return [
          call('w2', 'task', {
            description: 'Frontend',
            prompt: 'frontend using API /v1/items',
            subagent_type: 'general',
          }),
          { type: 'completed', stopReason: 'tool_use' },
        ];
      },
      () => done('Both waves done'),
    ],
    child: (prompt) => {
      order.push(prompt);
      return done(prompt === 'backend' ? 'API is /v1/items' : `built ${prompt}`);
    },
  });
  const session = createAgentSession({
    provider: routed.provider,
    tools: [createTaskTool(hostFor(routed.provider, []))],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'full stack' }));
  assert.deepEqual(order, ['backend', 'frontend using API /v1/items']);
  assert.equal(events.at(-1)?.type, 'session.completed');
});

test('a task can be resumed by task_id with its previous history', async () => {
  let childCalls = 0;
  let resumedHistory = 0;
  const routed = routedProvider({
    parent: [
      () => [
        call('a', 'task', { description: 'Start', prompt: 'first', subagent_type: 'explore' }),
        { type: 'completed', stopReason: 'tool_use' },
      ],
      (request) => {
        const result = JSON.stringify(request.messages);
        const id = /task_id: (\S+)/.exec(result)?.[1];
        assert.ok(id);
        return [
          call('b', 'task', {
            description: 'Continue',
            prompt: 'second',
            subagent_type: 'explore',
            task_id: id,
          }),
          { type: 'completed', stopReason: 'tool_use' },
        ];
      },
      () => done('ok'),
    ],
    child: (_prompt, request) => {
      childCalls += 1;
      resumedHistory = Math.max(resumedHistory, request.messages.length);
      return done(`answer ${childCalls}`);
    },
  });
  const session = createAgentSession({
    provider: routed.provider,
    tools: [createTaskTool(hostFor(routed.provider, []))],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  const starts = events.filter((e) => e.type === 'subagent.started');
  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.type === 'subagent.started' && starts[1].resumed, true);
  // The resumed child saw its first exchange plus the new prompt.
  assert.equal(resumedHistory, 3);
});

test('a failing child is reported as a failed task, not a crashed parent', async () => {
  const failing = {
    name: 'failing',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      if (request.systemPrompt?.includes('You are a subagent')) throw new Error('child model down');
      const answered = request.messages.some((m) =>
        m.content.some((b) => b.type === 'tool_result'),
      );
      yield* answered
        ? done('Recovered: the subtask failed, reporting it')
        : [
            call('t', 'task', { description: 'x', prompt: 'x', subagent_type: 'general' }),
            { type: 'completed', stopReason: 'tool_use' } as ModelStreamEvent,
          ];
    },
  };
  const session = createAgentSession({
    provider: failing,
    tools: [createTaskTool(hostFor(failing, []))],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  const completed = events.find((e) => e.type === 'subagent.completed');
  assert.equal(completed?.type === 'subagent.completed' && completed.status, 'failed');
  const toolResult = events.find((e) => e.type === 'tool.completed');
  assert.equal(toolResult?.type === 'tool.completed' && toolResult.result.isError, true);
  assert.equal(
    events.at(-1)?.type === 'session.completed' && events.at(-1)?.type,
    'session.completed',
  );
});

test('an unknown subagent type is rejected with the available list', async () => {
  const provider = new ScriptedModelProvider([
    [
      call('t', 'task', { description: 'x', prompt: 'x', subagent_type: 'wizard' }),
      { type: 'completed', stopReason: 'tool_use' },
    ],
    done('ok'),
  ]);
  const session = createAgentSession({
    provider,
    tools: [createTaskTool(hostFor(provider, []))],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  const result = events.find((e) => e.type === 'tool.completed');
  assert.ok(
    result?.type === 'tool.completed' && result.result.content.includes('explore, general'),
  );
});

test('explore subagents only get read-oriented tools', () => {
  const explore = DEFAULT_SUBAGENT_TYPES.find((type) => type.name === 'explore');
  assert.ok(explore && explore.tools !== 'inherit');
  assert.ok(!explore.tools.includes('write_file'));
  assert.ok(!explore.tools.includes('edit_file'));
});

test('a permission request raised inside a child is answered through the parent', async () => {
  const guarded: Tool<Record<string, never>> = {
    name: 'deploy',
    description: 'Deploy',
    inputSchema: z.object({}),
    jsonSchema: { type: 'object', properties: {} },
    kind: 'execute',
    concurrencySafe: false,
    async execute() {
      return { content: 'deployed' };
    },
  };
  const routed = routedProvider({
    parent: [
      () => [
        call('t', 'task', { description: 'deploy', prompt: 'deploy it', subagent_type: 'general' }),
        { type: 'completed', stopReason: 'tool_use' },
      ],
      () => done('done'),
    ],
    child: (_p, request) =>
      request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
        ? done('child finished')
        : [call('d', 'deploy', {}), { type: 'completed', stopReason: 'tool_use' }],
  });
  const host = hostFor(routed.provider, [guarded]);
  // The child asks; the default handler asks for `execute` tools.
  host.spawn = (spec) =>
    createAgentSession({
      sessionId: spec.taskId,
      provider: routed.provider,
      systemPrompt: spec.type.systemPrompt,
      tools: spec.tools,
      limits: { maxTurns: 4 },
    });
  const session = createAgentSession({
    provider: routed.provider,
    tools: [guarded, createTaskTool(host)],
    permissionHandler: new AllowAllPermissionHandler(),
    delegatePermission: (id, decision) => routeChildPermission(host.children, id, decision),
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'go' })) {
    events.push(event);
    if (event.type === 'permission.requested') {
      assert.equal(session.respondToPermission(event.requestId, 'allow'), true);
    }
  }
  assert.ok(events.some((e) => e.type === 'permission.requested' && e.toolName === 'deploy'));
  const completed = events.find((e) => e.type === 'subagent.completed');
  assert.equal(completed?.type === 'subagent.completed' && completed.summary, 'child finished');
});

test('three identical tool calls in a row are stopped and the model redirected', async () => {
  let executions = 0;
  const probe: Tool<{ q: string }> = {
    name: 'probe',
    description: 'Probe',
    inputSchema: z.object({ q: z.string() }),
    jsonSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    kind: 'read',
    concurrencySafe: false,
    async execute() {
      executions += 1;
      return { content: 'same' };
    },
  };
  const repeat = [
    call('x', 'probe', { q: 'a' }),
    { type: 'completed', stopReason: 'tool_use' } as const,
  ];
  const provider = new ScriptedModelProvider([
    repeat.map((e) => (e.type === 'tool_call' ? { ...e, id: 'x1' } : e)),
    repeat.map((e) => (e.type === 'tool_call' ? { ...e, id: 'x2' } : e)),
    repeat.map((e) => (e.type === 'tool_call' ? { ...e, id: 'x3' } : e)),
    (request) => {
      const last = JSON.stringify(request.messages.at(-1));
      assert.ok(last.includes('Change approach'));
      return done('I will try something else');
    },
  ]);
  const session = createAgentSession({
    provider,
    tools: [probe],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  assert.equal(executions, 2);
  assert.ok(events.some((e) => e.type === 'agent.intervention' && e.kind === 'doom_loop'));
});

test('consecutive failures trigger a reassessment reminder', async () => {
  const flaky: Tool<{ n: number }> = {
    name: 'flaky',
    description: 'Fails',
    inputSchema: z.object({ n: z.number() }),
    jsonSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    kind: 'read',
    concurrencySafe: false,
    async execute() {
      throw new Error('nope');
    },
  };
  const step = (n: number): ModelStreamEvent[] => [
    call(`f${n}`, 'flaky', { n }),
    { type: 'completed', stopReason: 'tool_use' },
  ];
  const provider = new ScriptedModelProvider([
    step(1),
    step(2),
    step(3),
    (request) => {
      assert.ok(JSON.stringify(request.messages.at(-1)).includes('Stop and reassess'));
      return done('Reassessing');
    },
  ]);
  const session = createAgentSession({
    provider,
    tools: [flaky],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  assert.ok(events.some((e) => e.type === 'agent.intervention' && e.kind === 'repeated_failure'));
});

test('the turn limit ends with a tool-free summary turn instead of stopping dead', async () => {
  const echo: Tool<{ v: number }> = {
    name: 'echo',
    description: 'Echo',
    inputSchema: z.object({ v: z.number() }),
    jsonSchema: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] },
    kind: 'read',
    concurrencySafe: false,
    async execute(input) {
      return { content: String(input.v) };
    },
  };
  let wrapUpTools = -1;
  const provider = new ScriptedModelProvider([
    [call('a', 'echo', { v: 1 }), { type: 'completed', stopReason: 'tool_use' }],
    (request) => {
      assert.ok(JSON.stringify(request.messages.at(-1)).includes('one working step left'));
      return [call('b', 'echo', { v: 2 }), { type: 'completed', stopReason: 'tool_use' }];
    },
    (request) => {
      wrapUpTools = request.tools.length;
      assert.ok(JSON.stringify(request.messages.at(-1)).includes('MAXIMUM STEPS REACHED'));
      return done('Summary: did 1 and 2. Remaining: 3.');
    },
  ]);
  const session = createAgentSession({
    provider,
    tools: [echo],
    permissionHandler: new AllowAllPermissionHandler(),
    limits: { maxTurns: 2 },
  });
  const events = await collect(session.run({ prompt: 'go' }));
  assert.equal(wrapUpTools, 0);
  assert.ok(events.some((e) => e.type === 'agent.intervention' && e.kind === 'turn_limit'));
  const end = events.at(-1);
  assert.equal(end?.type === 'session.completed' && end.reason, 'max_turns');
  const text = events
    .filter((e) => e.type === 'assistant.text.delta')
    .map((e) => (e.type === 'assistant.text.delta' ? e.delta : ''))
    .join('');
  assert.ok(text.includes('Remaining: 3'));
});

test('oversized tool output is spilled to the workspace with a retrieval hint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'spill-'));
  try {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const dump: Tool<Record<string, never>> = {
      name: 'dump',
      description: 'Dump',
      inputSchema: z.object({}),
      jsonSchema: { type: 'object', properties: {} },
      kind: 'read',
      concurrencySafe: false,
      async execute() {
        return { content: big, metadata: { stdout: big, exitCode: 0 } };
      },
    };
    let seen = '';
    const provider = new ScriptedModelProvider([
      [call('d1', 'dump', {}), { type: 'completed', stopReason: 'tool_use' }],
      (request) => {
        seen = JSON.stringify(request.messages.at(-1));
        return done('ok');
      },
    ]);
    const session = createAgentSession({
      provider,
      tools: [dump],
      workingDirectory: directory,
      permissionHandler: new AllowAllPermissionHandler(),
      loopPolicy: { spillToolOutputChars: 10_000 },
    });
    const events = await collect(session.run({ prompt: 'go' }));
    const completed = events.find((e) => e.type === 'tool.completed');
    assert.ok(completed?.type === 'tool.completed');
    const spilled = completed.result.metadata?.spilledTo;
    assert.equal(typeof spilled, 'string');
    assert.ok(completed.result.content.length < 12_000);
    assert.ok(seen.includes('read_file with offset and limit'));
    assert.ok(seen.includes('line 0 ') && seen.includes('line 4999 '));
    assert.equal(await readFile(path.join(directory, String(spilled)), 'utf8'), big);
    // Shell tools also echo raw stdout into metadata; that copy is shortened too,
    // or the history would still carry the output the spill moved to disk.
    assert.ok(String(completed.result.metadata?.stdout).length < 5_000);
    assert.ok(String(completed.result.metadata?.stdout).includes(String(spilled)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('todo_write changes are emitted as plan.updated events', async () => {
  const provider = new ScriptedModelProvider([
    [
      call('p1', 'todo_write', {
        todos: [
          { content: 'Plan', status: 'completed', activeForm: 'Planning' },
          { content: 'Build', status: 'in_progress', activeForm: 'Building' },
        ],
      }),
      { type: 'completed', stopReason: 'tool_use' },
    ],
    done('ok'),
  ]);
  const session = createAgentSession({
    provider,
    tools: [createTodoWriteTool()],
    permissionHandler: new AllowAllPermissionHandler(),
  });
  const events = await collect(session.run({ prompt: 'go' }));
  const plan = events.find((e) => e.type === 'plan.updated');
  assert.ok(plan?.type === 'plan.updated');
  assert.equal(plan.owner, 'main');
  assert.deepEqual(
    plan.todos.map((t) => t.status),
    ['completed', 'in_progress'],
  );
});

test('provider-reported input tokens tighten the next turn when the estimate runs low', async () => {
  const echo: Tool<{ v: number }> = {
    name: 'echo',
    description: 'Echo',
    inputSchema: z.object({ v: z.number() }),
    jsonSchema: { type: 'object', properties: { v: { type: 'number' } }, required: ['v'] },
    kind: 'read',
    concurrencySafe: false,
    async execute() {
      return { content: 'x'.repeat(8_000) };
    },
  };
  const budgets: number[] = [];
  const provider = new ScriptedModelProvider([
    [
      call('a', 'echo', { v: 1 }),
      // The provider counts half again what the estimator does.
      { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 10 } },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    done('ok'),
  ]);
  const session = createAgentSession({
    provider,
    tools: [echo],
    permissionHandler: new AllowAllPermissionHandler(),
    systemPrompt: 'y'.repeat(20_000),
    modelCapabilities: { contextWindow: 200_000, maxOutputTokens: 8_000 },
  });
  for await (const event of session.run({ prompt: 'go' })) {
    if (event.type === 'context.usage') budgets.push(event.budgetTokens);
  }
  assert.equal(budgets.length, 2);
  assert.ok(budgets[1]! < budgets[0]!, `calibrated budget ${budgets[1]} < ${budgets[0]}`);
});

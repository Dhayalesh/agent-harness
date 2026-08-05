import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSession,
  createTodoWriteTool,
  DefaultPermissionHandler,
  formatTodos,
  ScriptedModelProvider,
  TodoStore,
  type AgentEvent,
  type Tool,
  type ToolExecutionContext,
} from '../../src/index.js';

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    workingDirectory: process.cwd(),
    signal: new AbortController().signal,
    messages: [],
    reportProgress() {},
    ...overrides,
  };
}

test('todo_write stores the list and enforces a single in-progress task', async () => {
  const store = new TodoStore();
  const tool = createTodoWriteTool(store);

  const result = await tool.execute(
    {
      todos: [
        { content: 'Read the CAP model', status: 'completed', activeForm: 'Reading the CAP model' },
        { content: 'Add the service', status: 'in_progress', activeForm: 'Adding the service' },
        { content: 'Run the build', status: 'pending', activeForm: 'Running the build' },
      ],
    },
    context(),
  );
  assert.match(result.content, /modified successfully/);
  assert.equal(store.get('session').length, 3);
  assert.deepEqual(result.metadata?.counts, { pending: 1, inProgress: 1, completed: 1 });

  await assert.rejects(
    tool.execute(
      {
        todos: [
          { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
        ],
      },
      context(),
    ),
    /Only one task may be in_progress/,
  );

  await assert.rejects(
    tool.execute(
      {
        todos: [
          { content: 'Same', status: 'pending', activeForm: 'Doing' },
          { content: 'Same', status: 'pending', activeForm: 'Doing' },
        ],
      },
      context(),
    ),
    /Duplicate task content/,
  );
});

test('todo_write clears the stored list once everything is completed', async () => {
  const store = new TodoStore();
  const tool = createTodoWriteTool(store);
  await tool.execute(
    { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }] },
    context(),
  );
  assert.equal(store.get('session').length, 0);
  assert.equal(store.keys().length, 0);
});

test('todo lists render with status markers', () => {
  const rendered = formatTodos([
    { content: 'Done', status: 'completed', activeForm: 'Doing done' },
    { content: 'Active', status: 'in_progress', activeForm: 'Working on active' },
    { content: 'Later', status: 'pending', activeForm: 'Doing later' },
  ]);
  assert.equal(rendered, '[x] Done\n[~] Working on active\n[ ] Later');
  assert.equal(formatTodos([]), '(no tasks)');
});

test('a tool-level deny is absolute and short-circuits the permission handler', async () => {
  let handlerCalls = 0;
  const alwaysAllow = {
    evaluate(): 'allow' {
      handlerCalls += 1;
      return 'allow';
    },
  };
  let executed = false;
  const blocked: Tool<{ value: string }> = {
    name: 'blocked_tool',
    description: 'x',
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    jsonSchema: {},
    kind: 'execute',
    concurrencySafe: false,
    checkPermissions() {
      return { decision: 'deny', reason: 'never allowed' };
    },
    async execute() {
      executed = true;
      return { content: 'should not run' };
    },
  };

  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'tool_call', id: 'call-1', name: 'blocked_tool', input: { value: 'x' } },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [blocked],
    permissionHandler: alwaysAllow,
  });

  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'go' })) events.push(event);
  await session.close();

  const completed = events.find(
    (event): event is Extract<AgentEvent, { type: 'tool.completed' }> =>
      event.type === 'tool.completed',
  );
  assert.equal(completed?.result.isError, true);
  assert.match(completed?.result.content ?? '', /never allowed/);
  assert.equal(executed, false, 'denied tool must not execute');
  assert.equal(handlerCalls, 0, 'handler must not be consulted after a tool-level deny');
});

test('DefaultPermissionHandler defers to the tool check when present', () => {
  const handler = new DefaultPermissionHandler();
  const executeTool = { name: 'bash', kind: 'execute' } as unknown as Tool;
  const base = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    tool: executeTool,
    input: {},
    workingDirectory: process.cwd(),
  };
  assert.equal(handler.evaluate(base), 'ask');
  assert.equal(handler.evaluate({ ...base, toolCheck: { decision: 'allow' } }), 'allow');
});

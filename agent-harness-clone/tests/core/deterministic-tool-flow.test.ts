import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  ScriptedModelProvider,
  type AgentEvent,
  type Tool,
} from '../../src/index.js';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function lifecycle(events: readonly AgentEvent[], toolCallId: string): string[] {
  return events.flatMap((event) => {
    if (
      (event.type === 'tool.requested' || event.type === 'tool.started') &&
      event.call.id === toolCallId
    ) {
      return [event.type];
    }
    if (event.type === 'tool.completed' && event.result.toolCallId === toolCallId) {
      return [event.type];
    }
    return [];
  });
}

test('executes only model-requested web and file tools once through the session lifecycle', async () => {
  const executions: Array<{ name: string; input: unknown }> = [];
  const searchSchema = z.object({ query: z.string() });
  const fetchSchema = z.object({ url: z.string().url() });
  const readSchema = z.object({ path: z.string() });

  const webSearch: Tool<z.infer<typeof searchSchema>> = {
    name: 'web_search',
    description: 'Search the web',
    inputSchema: searchSchema,
    jsonSchema: { type: 'object' },
    kind: 'network',
    concurrencySafe: true,
    async execute(input) {
      executions.push({ name: 'web_search', input: structuredClone(input) });
      return { content: 'search unavailable', isError: true };
    },
  };
  const webFetch: Tool<z.infer<typeof fetchSchema>> = {
    name: 'web_fetch',
    description: 'Fetch one URL',
    inputSchema: fetchSchema,
    jsonSchema: { type: 'object' },
    kind: 'network',
    concurrencySafe: true,
    async execute(input) {
      executions.push({ name: 'web_fetch', input: structuredClone(input) });
      return { content: 'release 4.2' };
    },
  };
  const readFile: Tool<z.infer<typeof readSchema>> = {
    name: 'read_file',
    description: 'Read one workspace file',
    inputSchema: readSchema,
    jsonSchema: { type: 'object' },
    kind: 'read',
    concurrencySafe: true,
    async execute(input) {
      executions.push({ name: 'read_file', input: structuredClone(input) });
      return { content: 'status: ready' };
    },
  };

  const provider = new ScriptedModelProvider([
    [
      {
        type: 'tool_call',
        id: 'search-call',
        name: 'web_search',
        input: { query: 'latest/current Agent Harness release' },
      },
      { type: 'completed', stopReason: 'tool_use' },
    ],
    (request) => {
      const result = request.messages.at(-1)?.content[0];
      assert.equal(result?.type, 'tool_result');
      if (result?.type === 'tool_result') assert.equal(result.isError, true);
      return [
        {
          type: 'tool_call' as const,
          id: 'fetch-call',
          name: 'web_fetch',
          input: { url: 'https://example.test/releases/current' },
        },
        { type: 'completed' as const, stopReason: 'tool_use' as const },
      ];
    },
    (request) => {
      const result = request.messages.at(-1)?.content[0];
      assert.equal(result?.type, 'tool_result');
      if (result?.type === 'tool_result') assert.equal(result.content, 'release 4.2');
      return [
        {
          type: 'tool_call' as const,
          id: 'read-call',
          name: 'read_file',
          input: { path: 'docs/current/status.md' },
        },
        { type: 'completed' as const, stopReason: 'tool_use' as const },
      ];
    },
    (request) => {
      const result = request.messages.at(-1)?.content[0];
      assert.equal(result?.type, 'tool_result');
      if (result?.type === 'tool_result') assert.equal(result.content, 'status: ready');
      return [
        { type: 'text_delta' as const, delta: 'Done' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const session = createAgentSession({
    provider,
    tools: [webSearch, webFetch, readFile],
    permissionHandler: new AllowAllPermissionHandler(),
  });

  const events = await collect(session.run({ prompt: 'Check the latest release and local status.' }));

  assert.deepEqual(executions, [
    {
      name: 'web_search',
      input: { query: 'latest/current Agent Harness release' },
    },
    {
      name: 'web_fetch',
      input: { url: 'https://example.test/releases/current' },
    },
    {
      name: 'read_file',
      input: { path: 'docs/current/status.md' },
    },
  ]);
  assert.notEqual(
    (executions[0]?.input as { query?: string }).query,
    '/current',
    'freshness words must not be rewritten into a synthetic filesystem path',
  );
  for (const callId of ['search-call', 'fetch-call', 'read-call']) {
    assert.deepEqual(lifecycle(events, callId), [
      'tool.requested',
      'tool.started',
      'tool.completed',
    ]);
  }
  assert.equal(
    session.messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_call')
      .length,
    3,
  );
  assert.equal(
    session.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result').length,
    3,
  );
});

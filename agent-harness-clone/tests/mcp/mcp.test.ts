import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  McpConnection,
  ScriptedModelProvider,
  StructuredLogSink,
  type HarnessLogEntry,
} from '../../src/index.js';

test('discovers and calls MCP tools and resources over stdio', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.resolve(here, '../fixtures/mcp-server.mjs');
  let elicited = false;
  const activities: HarnessLogEntry[] = [];
  const structuredLines: string[] = [];
  const structured = new StructuredLogSink((line) => structuredLines.push(line));
  const connection = await McpConnection.connectStdio(
    'fixture',
    {
      command: process.execPath,
      args: [fixture],
      stderr: 'pipe',
    },
    {
      logSink: {
        log(entry) {
          activities.push(structuredClone(entry));
          structured.log(entry);
        },
      },
      logContext: { invocationId: 'invocation-1' },
      elicitationHandler(request) {
        elicited = true;
        assert.equal(request.message, 'Confirm fixture');
        return { action: 'accept', content: { answer: 'approved' } };
      },
    },
  );
  try {
    const tools = await connection.tools();
    const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
    assert.ok(echo);
    const result = await echo.execute(
      { text: 'hello MCP' },
      {
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'call',
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        messages: [],
        reportProgress() {},
      },
    );
    assert.equal(result.content, 'hello MCP');

    const ask = tools.find((tool) => tool.name === 'mcp__fixture__ask');
    assert.ok(ask);
    const askResult = await ask.execute(
      {},
      {
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'ask-call',
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        messages: [],
        reportProgress() {},
      },
    );
    assert.equal(askResult.content, 'approved');
    assert.equal(elicited, true);

    const fail = tools.find((tool) => tool.name === 'mcp__fixture__fail');
    assert.ok(fail);
    const failResult = await fail.execute(
      {},
      {
        sessionId: 'session',
        turnId: 'failure-turn',
        toolCallId: 'failure-call',
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        messages: [],
        reportProgress() {},
      },
    );
    assert.equal(failResult.content, 'fixture failure');
    assert.equal(failResult.isError, true);

    const session = createAgentSession({
      sessionId: 'agent-mcp-session',
      provider: new ScriptedModelProvider([
        [
          {
            type: 'tool_call',
            id: 'agent-mcp-call',
            name: 'mcp__fixture__echo',
            input: { text: 'called through the session' },
          },
          { type: 'completed', stopReason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: 'MCP call completed.' },
          { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      tools: [echo],
      permissionHandler: new AllowAllPermissionHandler(),
      logSink: structured,
      logContext: { invocationId: 'invocation-1' },
      workingDirectory: process.cwd(),
    });
    for await (const _event of session.run({ prompt: 'Call the MCP echo tool.' })) {
      // Lifecycle assertions below use the correlated structured log.
    }
    await session.close();

    const resources = await connection.listResources();
    assert.equal(resources[0]?.uri, 'fixture://hello');
    const contents = await connection.readResource('fixture://hello');
    assert.equal(contents[0]?.text, 'resource contents');

    const prompts = await connection.listPrompts();
    assert.equal(prompts[0]?.name, 'greeting');
    assert.equal(prompts[0]?.arguments?.[0]?.name, 'name');
    const prompt = await connection.getPrompt('greeting', { name: 'Harness' });
    assert.equal(prompt.description, 'A generated greeting');
    assert.deepEqual(prompt.messages[0], {
      role: 'user',
      content: { type: 'text', text: 'Hello Harness' },
    });
  } finally {
    await connection.close();
  }

  const events = activities.map((entry) => entry.event);
  assert.equal(events[0], 'mcp.connection.started');
  assert.ok(events.includes('mcp.connection.completed'));
  assert.ok(events.includes('mcp.tools.discovered'));
  assert.ok(events.includes('mcp.elicitation.started'));
  assert.ok(events.includes('mcp.elicitation.completed'));
  assert.equal(events.at(-1), 'mcp.connection.close.completed');
  const call = activities.find(
    (entry) => entry.event === 'mcp.request.completed' && entry.operation === 'tools/call',
  );
  assert.ok(call);
  assert.equal(call.invocationId, 'invocation-1');
  assert.equal(call.remoteTool, 'echo');
  assert.equal(call.toolCallId, 'call');
  assert.equal(call.turnId, 'turn');
  assert.equal(call.sessionId, 'session');
  assert.equal(call.remoteError, false);
  assert.equal(typeof call.mcpRequestId, 'string');
  assert.ok(Number(call.durationMs) >= 0);
  const callStarted = activities.find(
    (entry) =>
      entry.event === 'mcp.request.started' &&
      entry.operation === 'tools/call' &&
      entry.toolCallId === 'call',
  );
  assert.ok(callStarted);
  assert.equal(callStarted.mcpRequestId, call.mcpRequestId);
  assert.ok(activities.indexOf(callStarted) < activities.indexOf(call));
  const remoteFailure = activities.find(
    (entry) =>
      entry.event === 'mcp.request.completed' &&
      entry.operation === 'tools/call' &&
      entry.toolCallId === 'failure-call',
  );
  assert.ok(remoteFailure);
  assert.equal(remoteFailure.remoteError, true);
  assert.equal(remoteFailure.level, 'error');
  assert.equal(remoteFailure.turnId, 'failure-turn');

  const structuredRecords = structuredLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const lifecycle = [
    'tool.requested',
    'tool.execution.started',
    'mcp.request.started',
    'mcp.request.completed',
    'tool.execution.completed',
  ];
  let previous = -1;
  for (const event of lifecycle) {
    const index = structuredRecords.findIndex(
      (record, candidate) =>
        candidate > previous && record.event === event && record.toolCallId === 'agent-mcp-call',
    );
    assert.ok(index > previous, `${event} is missing or out of order`);
    previous = index;
  }
  const nestedMcp = structuredRecords.filter(
    (record) =>
      record.toolCallId === 'agent-mcp-call' && String(record.event).startsWith('mcp.request.'),
  );
  assert.equal(nestedMcp.length, 2);
  assert.equal(nestedMcp[0]?.mcpRequestId, nestedMcp[1]?.mcpRequestId);
  assert.ok(
    structuredRecords.some(
      (record, index) =>
        index > previous &&
        record.event === 'output.completed' &&
        record.sessionId === 'agent-mcp-session',
    ),
  );
});

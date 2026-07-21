import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AllowAllPermissionHandler,
  createAgentSession,
  HookRegistry,
  ScriptedModelProvider,
  type AgentHook,
  type Tool,
} from '../../src/index.js';
import { z } from 'zod';

test('stop hook can request one bounded continuation', async () => {
  let stops = 0;
  const hook: AgentHook = {
    name: 'verify-once',
    onStop() {
      stops += 1;
      return stops === 1 ? { continueWithPrompt: 'Verify the answer' } : {};
    },
  };
  const provider = new ScriptedModelProvider([
    [
      { type: 'text_delta', delta: 'draft' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
    (request) => {
      const last = request.messages.at(-1);
      assert.equal(last?.content[0]?.type, 'text');
      if (last?.content[0]?.type === 'text')
        assert.equal(last.content[0].text, 'Verify the answer');
      return [
        { type: 'text_delta' as const, delta: 'verified' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const session = createAgentSession({ provider, hooks: new HookRegistry([hook]) });
  for await (const _event of session.run({ prompt: 'answer' })) {
    // Consume.
  }
  assert.equal(stops, 2);
});

test('pre-tool hook blocks execution without a UI dependency', async () => {
  let executed = false;
  const schema = z.object({});
  const tool: Tool<z.infer<typeof schema>> = {
    name: 'blocked',
    description: 'must not execute',
    inputSchema: schema,
    jsonSchema: { type: 'object' },
    kind: 'write',
    concurrencySafe: false,
    async execute() {
      executed = true;
      return { content: 'bad' };
    },
  };
  const hooks = new HookRegistry([
    {
      name: 'policy-hook',
      beforeTool: () => ({ allow: false, message: 'blocked by policy' }),
    },
  ]);
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'tool_call', id: 'blocked-call', name: 'blocked', input: {} },
        { type: 'completed', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', delta: 'handled' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    tools: [tool],
    hooks,
    permissionHandler: new AllowAllPermissionHandler(),
  });
  for await (const _event of session.run({ prompt: 'run' })) {
    // Consume.
  }
  assert.equal(executed, false);
  assert.match(JSON.stringify(session.messages), /blocked by policy/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CliAgentAdapter,
  createAgentSession,
  createSkillTool,
  ScriptedModelProvider,
  SkillRegistry,
  startAgentSseServer,
} from '../../src/index.js';

test('the same skill executes through CLI and server adapters', async () => {
  const skills = new SkillRegistry([
    {
      name: 'verify',
      description: 'Verify the work',
      instructions: 'Run focused verification before finishing.',
    },
  ]);
  const factory = () =>
    createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'tool_call', id: 'skill-call', name: 'skill', input: { name: 'verify' } },
          { type: 'completed', stopReason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: 'skill applied' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      tools: [createSkillTool(skills)],
    });

  const cliEvents = await new CliAgentAdapter().run(factory(), 'verify');
  assert.ok(
    cliEvents.some(
      (event) =>
        event.type === 'tool.completed' &&
        event.result.content.includes('Run focused verification'),
    ),
  );

  const server = await startAgentSseServer({ createSession: factory });
  try {
    const response = await fetch(`${server.url}/sessions/run`, {
      method: 'POST',
      body: JSON.stringify({ prompt: 'verify' }),
    });
    assert.match(await response.text(), /Run focused verification/);
  } finally {
    await server.close();
  }
});

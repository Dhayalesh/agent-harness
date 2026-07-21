import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentTeamCoordinator,
  createAgentSession,
  ScriptedModelProvider,
} from '../../src/index.js';

test('team coordinator runs scoped roles concurrently and synthesizes results', async () => {
  const coordinator = new AgentTeamCoordinator({
    agents: [
      { role: 'reviewer', description: 'Review correctness', allowedTools: ['read_file'] },
      { role: 'tester', description: 'Plan tests', allowedTools: ['bash'] },
    ],
    createAgent(definition) {
      return createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: `${definition.role} result` },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
        limits: { maxTurns: definition.maxTurns ?? 2 },
      });
    },
    createCoordinator() {
      return createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'combined result' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
      });
    },
  });
  const result = await coordinator.run('inspect');
  assert.deepEqual(
    result.results.map((entry) => entry.role),
    ['reviewer', 'tester'],
  );
  assert.equal(result.synthesis, 'combined result');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSession, runParityScenario, ScriptedModelProvider } from '../../src/index.js';

test('shadow parity runner compares normalized observable behavior', async () => {
  const factory = () =>
    createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'same answer' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
    });
  const result = await runParityScenario(factory, factory, 'compare');
  assert.equal(result.matches, true);
  assert.deepEqual(result.differences, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSession, ScriptedModelProvider } from '../../src/index.js';

test('deterministic no-tool session completes within the regression budget', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'fast' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
  });
  const start = performance.now();
  for await (const _event of session.run({ prompt: 'measure' })) {
    // Consume.
  }
  assert.ok(performance.now() - start < 250);
});

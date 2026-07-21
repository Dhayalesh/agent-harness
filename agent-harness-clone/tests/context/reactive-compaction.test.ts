import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSession, ScriptedModelProvider, type AgentEvent } from '../../src/index.js';

test('prompt-too-long failure compacts and retries exactly once', async () => {
  let attempts = 0;
  const provider = new ScriptedModelProvider([
    () => {
      attempts += 1;
      throw Object.assign(new Error('prompt is too long'), { status: 413 });
    },
    (request) => {
      attempts += 1;
      assert.match(JSON.stringify(request.messages), /Compacted earlier conversation/);
      return [
        { type: 'text_delta' as const, delta: 'recovered after compaction' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const session = createAgentSession({ provider });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'x'.repeat(20_000) })) events.push(event);
  assert.equal(attempts, 2);
  assert.ok(
    events.some((event) => event.type === 'warning' && event.code === 'REACTIVE_COMPACTION'),
  );
});

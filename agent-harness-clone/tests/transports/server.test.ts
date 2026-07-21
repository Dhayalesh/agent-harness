import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSession, ScriptedModelProvider, startAgentSseServer } from '../../src/index.js';

test('SSE server streams events from the shared session API', async () => {
  const server = await startAgentSseServer({
    createSession: () =>
      createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'server response' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
      }),
  });
  try {
    const response = await fetch(`${server.url}/sessions/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: assistant\.text\.delta/);
    assert.match(body, /server response/);
    assert.match(body, /event: session\.completed/);
  } finally {
    await server.close();
  }
});

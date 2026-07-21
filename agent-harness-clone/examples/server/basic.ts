import { createAgentSession, ScriptedModelProvider, startAgentSseServer } from '../../src/index.js';

const server = await startAgentSseServer({
  createSession: () =>
    createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'text_delta', delta: 'Hello from the server adapter.' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
    }),
  port: 3000,
});

console.log(`Agent SSE server listening at ${server.url}`);

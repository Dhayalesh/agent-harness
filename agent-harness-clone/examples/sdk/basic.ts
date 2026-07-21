import { createAgentSession, ScriptedModelProvider } from '../../src/index.js';

const provider = new ScriptedModelProvider([
  [
    { type: 'text_delta', delta: 'Hello from the shared agent harness.' },
    { type: 'completed', stopReason: 'end_turn' },
  ],
]);

const session = createAgentSession({ provider });
for await (const event of session.run({ prompt: 'Say hello' })) {
  console.log(JSON.stringify(event));
}

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createAgentSession, runJsonlAdapter, ScriptedModelProvider } from '../../src/index.js';

test('headless JSONL adapter runs the same session protocol', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString('utf8');
  });
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'jsonl answer' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
  });
  const running = runJsonlAdapter(session, input, output);
  input.end(`${JSON.stringify({ type: 'run', prompt: 'hello' })}\n`);
  await running;
  assert.match(rendered, /assistant\.text\.delta/);
  assert.match(rendered, /jsonl answer/);
  assert.match(rendered, /session\.completed/);
});

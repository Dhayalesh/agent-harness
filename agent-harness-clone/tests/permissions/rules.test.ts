import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { RulePermissionHandler, type PermissionRequest, type Tool } from '../../src/index.js';

const schema = z.object({ command: z.string() });
const tool: Tool<z.infer<typeof schema>> = {
  name: 'bash',
  description: 'shell',
  inputSchema: schema,
  jsonSchema: { type: 'object' },
  kind: 'execute',
  concurrencySafe: false,
  async execute() {
    return { content: '' };
  },
};

function request(command: string): PermissionRequest {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    tool,
    input: { command },
    workingDirectory: '/workspace',
  };
}

test('rules choose allow and deny decisions by tool input', () => {
  const handler = new RulePermissionHandler({
    rules: [
      { tool: 'bash', inputPattern: 'npm test*', decision: 'allow' },
      { tool: 'bash', inputPattern: 'rm *', decision: 'deny' },
    ],
  });
  assert.equal(handler.evaluate(request('npm test -- unit')), 'allow');
  assert.equal(handler.evaluate(request('rm file')), 'deny');
  assert.equal(handler.evaluate(request('git status')), 'ask');
});

test('plan mode denies mutation and bypass mode allows it', () => {
  assert.equal(new RulePermissionHandler({ mode: 'plan' }).evaluate(request('npm test')), 'deny');
  assert.equal(new RulePermissionHandler({ mode: 'bypass' }).evaluate(request('rm file')), 'allow');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextIntelligenceReport,
  ContextIntelligenceEngine,
  createAgentSession,
  ScriptedModelProvider,
  type AgentEvent,
} from '../../src/index.js';

const SECRET_REQUEST = 'compare private-project-orchid with the current plan';

test('projects a Context Contract into bounded content-free application telemetry', async () => {
  const engine = new ContextIntelligenceEngine();
  const { contract } = await engine.prepare({
    request: SECRET_REQUEST,
    messages: [],
    tools: [],
    systemPrompt: 'Keep internal project details private.',
    scope: {
      applicationId: 'test-console',
      conversationId: 'conversation-1',
      taskId: 'task-1',
      namespaces: ['test'],
    },
    sessionId: 'session-1',
    turnId: 'turn-1',
    inputLimit: 128_000,
    outputReservation: 8_192,
    signal: new AbortController().signal,
  });

  const report = contextIntelligenceReport(contract);
  const serialized = JSON.stringify(report);

  assert.equal(report.version, 1);
  assert.equal(report.requestId, contract.requestId);
  assert.equal(report.intent.operation, contract.intent.operation);
  assert.equal(report.budget.usedInput, contract.budget.usedInput);
  assert.equal(report.finalContext.items, contract.items.length);
  assert.equal(report.quality.status, contract.quality.status);
  assert.equal(serialized.includes('private-project-orchid'), false);
  assert.equal(serialized.includes('Keep internal project details private'), false);
  assert.equal('rawRequest' in report, false);
  assert.equal('items' in report.finalContext, true);
});

test('a Context Intelligence session emits the report on the public event stream', async () => {
  const session = createAgentSession({
    provider: new ScriptedModelProvider([
      [
        { type: 'text_delta', delta: 'Done.' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]),
    contextIntelligence: {},
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: SECRET_REQUEST })) events.push(event);

  const intelligence = events.find((event) => event.type === 'context.intelligence');
  assert.ok(intelligence && intelligence.type === 'context.intelligence');
  assert.equal(intelligence.report.version, 1);
  assert.equal(JSON.stringify(intelligence.report).includes('private-project-orchid'), false);
  assert.ok(
    events.indexOf(intelligence) <
      events.findIndex((event) => event.type === 'assistant.text.delta'),
  );
});

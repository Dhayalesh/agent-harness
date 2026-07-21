import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CompactingContextManager,
  createAgentSession,
  ScriptedModelProvider,
  type AgentEvent,
} from '../../src/index.js';

test('compacts oversized model context and emits lifecycle events', async () => {
  const provider = new ScriptedModelProvider([
    (request) => {
      assert.match(JSON.stringify(request.messages), /Compacted earlier conversation/);
      return [
        { type: 'text_delta' as const, delta: 'done' },
        { type: 'completed' as const, stopReason: 'end_turn' as const },
      ];
    },
  ]);
  const session = createAgentSession({
    provider,
    contextManager: new CompactingContextManager({
      maxInputTokens: 20,
      retainRecentMessages: 0,
    }),
  });
  const events: AgentEvent[] = [];
  for await (const event of session.run({ prompt: 'x'.repeat(500) })) events.push(event);
  assert.ok(events.some((event) => event.type === 'context.compaction.started'));
  assert.ok(events.some((event) => event.type === 'context.compaction.completed'));
});

test('compaction never separates a tool result from its assistant tool call', async () => {
  const manager = new CompactingContextManager({
    maxInputTokens: 10,
    retainRecentMessages: 1,
  });
  const messages = [
    {
      id: 'user',
      role: 'user' as const,
      createdAt: new Date().toISOString(),
      content: [{ type: 'text' as const, text: 'x'.repeat(100) }],
    },
    {
      id: 'assistant',
      role: 'assistant' as const,
      createdAt: new Date().toISOString(),
      content: [{ type: 'tool_call' as const, id: 'call', name: 'read', input: {} }],
    },
    {
      id: 'result',
      role: 'user' as const,
      createdAt: new Date().toISOString(),
      content: [
        {
          type: 'tool_result' as const,
          toolCallId: 'call',
          content: 'result',
          isError: false,
        },
      ],
    },
  ];
  const prepared = await manager.prepare({ messages });
  assert.equal(prepared.messages.at(-2)?.id, 'assistant');
  assert.equal(prepared.messages.at(-1)?.id, 'result');
});

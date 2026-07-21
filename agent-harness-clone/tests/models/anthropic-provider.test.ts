import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnthropicModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../../src/index.js';

const request: ModelRequest = {
  messages: [],
  tools: [],
  signal: new AbortController().signal,
};

test('Anthropic adapter rejects malformed streamed tool JSON', async () => {
  const fakeClient = {
    messages: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'call', name: 'tool', input: {} },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{invalid' },
            };
            yield { type: 'content_block_stop', index: 0 };
          },
        };
      },
    },
  };
  const provider = new AnthropicModelProvider({ client: fakeClient as never });
  await assert.rejects(async () => {
    for await (const _event of provider.stream(request)) {
      // Consume.
    }
  }, /malformed JSON/);
});

test(
  'optional live Anthropic adapter completes a real tool trajectory',
  { skip: !process.env.AGENT_HARNESS_LIVE_ANTHROPIC },
  async () => {
    const provider = new AnthropicModelProvider();
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream({
      ...request,
      model: process.env.AGENT_HARNESS_LIVE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
      messages: [
        {
          id: 'user',
          role: 'user',
          createdAt: new Date().toISOString(),
          content: [
            {
              type: 'text',
              text: 'Call the echo tool exactly once with value live-test. Do not answer directly.',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'echo',
          description: 'Echo a value',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'echo'));
  },
);

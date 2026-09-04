import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAICompatibleModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../../src/index.js';

const baseRequest: ModelRequest = {
  messages: [
    {
      id: 'user',
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: 'Use the echo tool' }],
    },
  ],
  tools: [
    {
      name: 'echo',
      description: 'Echo input',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
  ],
  systemPrompt: 'System instructions',
  signal: new AbortController().signal,
};

test('OpenAI-compatible provider maps messages, tools, usage, and streamed tool fragments', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const provider = new OpenAICompatibleModelProvider({
    apiKey: 'test-key',
    baseURL: 'https://compatible.example/v1/',
    defaultModel: 'test/model',
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'echo', arguments: '{"val' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'ue":"ok"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
            cost: '0.001',
          },
        },
      ]);
    },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(baseRequest)) events.push(event);

  assert.equal(capturedUrl, 'https://compatible.example/v1/chat/completions');
  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'test/model');
  assert.deepEqual((body.messages as unknown[])[0], {
    role: 'system',
    content: 'System instructions',
  });
  // The fragments are reported as they arrive as well as assembled at the end, so
  // a caller watching a stream can show the call before it is complete.
  assert.deepEqual(events, [
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call-1',
      name: 'echo',
      argumentsDelta: '{"val',
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
        estimatedCostUsd: 0.001,
      },
    },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'call-1',
      name: 'echo',
      argumentsDelta: 'ue":"ok"}',
    },
    { type: 'tool_call', id: 'call-1', name: 'echo', input: { value: 'ok' } },
    { type: 'completed', stopReason: 'tool_use' },
  ]);
  // Reasoning is neither asked for nor sent unless the provider is configured for it.
  assert.equal(body.reasoning, undefined);
  assert.equal(body.include_reasoning, undefined);
});

test('reasoning deltas are forwarded and counted, in either spelling', async () => {
  const seen: Array<{ requested: boolean; events: ModelStreamEvent[] }> = [];
  for (const field of ['reasoning', 'reasoning_content'] as const) {
    let capturedBody: Record<string, unknown> = {};
    const provider = new OpenAICompatibleModelProvider({
      apiKey: 'test-key',
      baseURL: 'https://compatible.example/v1',
      defaultModel: 'test/model',
      requestReasoning: true,
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([
          { choices: [{ delta: { [field]: 'Weighing ' }, finish_reason: null }] },
          { choices: [{ delta: { [field]: 'the options.' }, finish_reason: null }] },
          { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 40,
              completion_tokens_details: { reasoning_tokens: 30 },
            },
          },
        ]);
      },
    });
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream(baseRequest)) events.push(event);
    seen.push({ requested: capturedBody.include_reasoning === true, events });
  }

  for (const { requested, events } of seen) {
    assert.equal(requested, true);
    assert.deepEqual(
      events.filter((event) => event.type === 'reasoning_delta'),
      [
        { type: 'reasoning_delta', delta: 'Weighing ' },
        { type: 'reasoning_delta', delta: 'the options.' },
      ],
    );
    // Deliberation is not the answer, and must not be folded into it.
    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta'),
      [{ type: 'text_delta', delta: 'Answer.' }],
    );
    const usage = events.find((event) => event.type === 'usage');
    assert.equal(usage?.type === 'usage' ? usage.usage.reasoningTokens : undefined, 30);
  }
});

test('OpenAI-compatible provider keeps the OpenAI output-limit field', async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAICompatibleModelProvider({
    apiKey: 'test-key',
    baseURL: 'https://compatible.example/v1',
    defaultModel: 'test/model',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }]);
    },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream({ ...baseRequest, maxOutputTokens: 256 })) {
    events.push(event);
  }
  assert.equal(body.max_completion_tokens, 256);
  assert.deepEqual(events, [
    { type: 'text_delta', delta: 'hello' },
    { type: 'completed', stopReason: 'end_turn' },
  ]);
});

test('OpenAI-compatible provider surfaces HTTP status for retry policy', async () => {
  const provider = new OpenAICompatibleModelProvider({
    apiKey: 'test-key',
    baseURL: 'https://compatible.example/v1',
    defaultModel: 'test/model',
    fetch: async () => new Response('busy', { status: 503 }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream(baseRequest)) {
        // Consume.
      }
    },
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 503,
  );
});

function sseResponse(chunks: readonly unknown[]): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

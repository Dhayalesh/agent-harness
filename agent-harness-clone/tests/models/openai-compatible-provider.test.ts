import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOpenRouterProvider,
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
          usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.001 },
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
  assert.deepEqual(events, [
    {
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 },
    },
    { type: 'tool_call', id: 'call-1', name: 'echo', input: { value: 'ok' } },
    { type: 'completed', stopReason: 'tool_use' },
  ]);
});

test('OpenRouter preset uses the compatible endpoint and attribution headers', async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const provider = createOpenRouterProvider({
    apiKey: 'openrouter-key',
    defaultModel: 'anthropic/test-model',
    appUrl: 'https://app.example',
    appName: 'Harness Platform',
    fetch: async (input, init) => {
      request = { input: String(input), ...(init === undefined ? {} : { init }) };
      return sseResponse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }]);
    },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream({ ...baseRequest, tools: [] })) events.push(event);
  assert.equal(request?.input, 'https://openrouter.ai/api/v1/chat/completions');
  const headers = request?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer openrouter-key');
  assert.equal(headers['HTTP-Referer'], 'https://app.example');
  assert.equal(headers['X-OpenRouter-Title'], 'Harness Platform');
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

test(
  'optional live OpenRouter adapter streams a completion',
  { skip: !process.env.AGENT_HARNESS_LIVE_OPENROUTER },
  async () => {
    const provider = createOpenRouterProvider({
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      defaultModel: process.env.AGENT_HARNESS_LIVE_OPENROUTER_MODEL ?? 'openai/gpt-4.1-mini',
    });
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream({ ...baseRequest, tools: [] })) events.push(event);
    assert.ok(events.some((event) => event.type === 'text_delta'));
  },
);

function sseResponse(chunks: readonly unknown[]): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

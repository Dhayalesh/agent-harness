import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listOpenRouterModels,
  OpenRouterModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
} from '../../src/index.js';

const MODEL = 'anthropic/claude-sonnet-4.6';

const request: ModelRequest = {
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

test('OpenRouter provider requires a credential', () => {
  assert.throws(
    () => new OpenRouterModelProvider({ apiKey: '  ', defaultModel: MODEL }),
    /OpenRouter provider requires an API key/,
  );
});

test('OpenRouter provider requires a model, with no environment fallback', () => {
  process.env.OPENROUTER_MODEL = 'vendor/from-environment';
  try {
    assert.throws(
      () => new OpenRouterModelProvider({ apiKey: 'openrouter-key', defaultModel: '  ' }),
      /OpenRouter provider requires a model/,
    );
  } finally {
    delete process.env.OPENROUTER_MODEL;
  }
});

test('OpenRouter provider targets the gateway with attribution and routing', async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const provider = new OpenRouterModelProvider({
    apiKey: 'openrouter-key',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    appUrl: 'https://app.example',
    appName: 'Agent Harness',
    fallbackModels: ['openai/gpt-4.1-mini', 'google/gemini-2.5-pro'],
    providerRouting: { order: ['anthropic'] },
    fetch: async (input, init) => {
      captured = { url: String(input), ...(init === undefined ? {} : { init }) };
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
          usage: { prompt_tokens: 20, completion_tokens: 6, cost: 0.002 },
        },
      ]);
    },
  });

  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream({ ...request, maxOutputTokens: 512 })) {
    events.push(event);
  }

  assert.equal(provider.name, 'openrouter');
  assert.equal(captured?.url, 'https://openrouter.ai/api/v1/chat/completions');
  const headers = captured?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer openrouter-key');
  assert.equal(headers['HTTP-Referer'], 'https://app.example');
  assert.equal(headers['X-OpenRouter-Title'], 'Agent Harness');
  const body = JSON.parse(String(captured?.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, 'anthropic/claude-sonnet-4.6');
  assert.equal(body.max_tokens, 512);
  assert.equal(body.max_completion_tokens, undefined);
  assert.deepEqual(body.models, ['openai/gpt-4.1-mini', 'google/gemini-2.5-pro']);
  assert.deepEqual(body.provider, { order: ['anthropic'] });
  assert.deepEqual((body.messages as unknown[])[0], {
    role: 'system',
    content: 'System instructions',
  });
  assert.deepEqual(events, [
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 6, estimatedCostUsd: 0.002 } },
    { type: 'tool_call', id: 'call-1', name: 'echo', input: { value: 'ok' } },
    { type: 'completed', stopReason: 'tool_use' },
  ]);
});

test('OpenRouter provider rejects malformed streamed tool JSON', async () => {
  const provider = new OpenRouterModelProvider({
    apiKey: 'openrouter-key',
    defaultModel: MODEL,
    fetch: async () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-1', function: { name: 'echo', arguments: '{invalid' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
  });
  await assert.rejects(async () => {
    for await (const _event of provider.stream(request)) {
      // Consume.
    }
  }, /malformed JSON/);
});

test('OpenRouter provider omits tools when the session exposes none', async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenRouterModelProvider({
    apiKey: 'openrouter-key',
    defaultModel: MODEL,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]);
    },
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream({ ...request, tools: [] })) events.push(event);
  assert.equal(body.model, MODEL);
  assert.equal('tools' in body, false);
  assert.deepEqual(events, [
    { type: 'text_delta', delta: 'hi' },
    { type: 'completed', stopReason: 'end_turn' },
  ]);
});

test('model catalog resolves availability from the OpenRouter models endpoint', async () => {
  const listing = {
    data: [
      {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        context_length: 1_000_000,
        architecture: { input_modalities: ['text', 'image'] },
        pricing: { prompt: '0.000003', completion: '0.000015' },
        top_provider: { max_completion_tokens: 64_000 },
        supported_parameters: ['tools', 'max_tokens'],
      },
      {
        id: 'vendor/no-tools',
        name: 'No Tools',
        context_length: 8_192,
        supported_parameters: ['max_tokens'],
      },
    ],
  };
  let capturedUrl = '';
  const fetchImplementation: typeof fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify(listing), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const models = await listOpenRouterModels({
    apiKey: 'openrouter-key',
    fetch: fetchImplementation,
    toolCapableOnly: true,
  });
  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/models');
  assert.deepEqual(models, [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      contextLength: 1_000_000,
      supportsTools: true,
      inputModalities: ['text', 'image'],
      maxCompletionTokens: 64_000,
      promptUsdPerToken: 0.000003,
      completionUsdPerToken: 0.000015,
    },
  ]);

  const provider = new OpenRouterModelProvider({
    apiKey: 'openrouter-key',
    defaultModel: MODEL,
    fetch: fetchImplementation,
  });
  await provider.assertModelAvailable('anthropic/claude-sonnet-4.6');
  await assert.rejects(
    provider.assertModelAvailable('vendor/missing'),
    /not available on OpenRouter/,
  );
});

test('OpenRouter provider surfaces HTTP status for retry policy', async () => {
  const provider = new OpenRouterModelProvider({
    apiKey: 'openrouter-key',
    defaultModel: MODEL,
    fetch: async () => new Response('busy', { status: 503 }),
  });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream(request)) {
        // Consume.
      }
    },
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 503,
  );
});

test(
  'optional live OpenRouter adapter completes a real tool trajectory',
  { skip: !process.env.AGENT_HARNESS_LIVE_OPENROUTER },
  async () => {
    const provider = new OpenRouterModelProvider({
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      defaultModel: process.env.AGENT_HARNESS_LIVE_OPENROUTER_MODEL ?? MODEL,
    });
    await provider.assertModelAvailable();
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream({
      ...request,
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
    })) {
      events.push(event);
    }
    assert.ok(events.some((event) => event.type === 'tool_call' && event.name === 'echo'));
  },
);

function sseResponse(chunks: readonly unknown[]): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

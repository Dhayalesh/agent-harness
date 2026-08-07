import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  assertRuntimeSupport,
  parseModelProviderInput,
  PlatformModelProviderRegistry,
  RUNTIME_SUPPORT,
  type ModelProviderLookup,
  type ModelProviderRecord,
  type ModelRequest,
  type ModelStreamEvent,
} from '../../src/index.js';

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: false,
  reportsCost: false,
};

/** Hex form of an `ObjectId`, which is what the store's methods take. */
const RECORD_ID = '6a67cb6e3c57852f5710071c';

function record(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  const timestamp = new Date().toISOString();
  return {
    name: 'primary',
    provider: 'openai-compatible',
    model: 'zai.glm-5',
    baseURL: 'https://models.internal.example/v1',
    apiKey: 'test-key',
    auth: { kind: 'bearer' },
    capabilities,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'operator',
    ...overrides,
  };
}

function lookup(value: ModelProviderRecord | undefined): ModelProviderLookup {
  return {
    async get() {
      return value;
    },
    async getByName() {
      return value;
    },
    async getDefault() {
      return value;
    },
  };
}

function modelRequest(): ModelRequest {
  return {
    messages: [
      {
        id: 'user',
        role: 'user',
        createdAt: new Date().toISOString(),
        content: [{ type: 'text', text: 'ping' }],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
  };
}

async function startStubModelServer(): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`,
    );
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseURL: `http://127.0.0.1:${port}/v1` };
}

test('a stored record resolves to a provider that completes a turn against a stub server', async () => {
  const { server, baseURL } = await startStubModelServer();
  const logged: string[] = [];
  try {
    const registry = new PlatformModelProviderRegistry(lookup(record({ baseURL })), {
      logger: (message) => logged.push(message),
    });
    const provider = await registry.resolveById(RECORD_ID);
    const events: ModelStreamEvent[] = [];
    for await (const event of provider.stream(modelRequest())) events.push(event);

    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta'),
      [{ type: 'text_delta', delta: 'pong' }],
    );
    assert.deepEqual(events.at(-1), { type: 'completed', stopReason: 'end_turn' });

    // Resolution must name the unhonoured capabilities exactly once, and must
    // not claim the honoured ones are dropped.
    assert.deepEqual(RUNTIME_SUPPORT.capabilitiesHonoured, [
      'contextWindow',
      'maxOutputTokens',
      'supportsReasoning',
    ]);
    assert.equal(logged.length, 1);
    assert.match(logged[0] as string, /capabilities for 'primary' are not in effect/);
    assert.match(logged[0] as string, /supportsTools=true/);
    assert.doesNotMatch(logged[0] as string, /contextWindow|maxOutputTokens|supportsReasoning/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the record baseURL is used as written, with no allowlist to consult', async () => {
  const registry = new PlatformModelProviderRegistry(
    lookup(record({ baseURL: 'https://anything.example/v1' })),
    { logger: () => {} },
  );
  assert.equal((await registry.resolveById(RECORD_ID)).name, 'retry(openai-compatible)');

  const openrouter = new PlatformModelProviderRegistry(
    lookup(
      record({ provider: 'openrouter', baseURL: undefined, model: 'anthropic/claude-sonnet-4.6' }),
    ),
    { logger: () => {} },
  );
  assert.equal((await openrouter.resolveById(RECORD_ID)).name, 'retry(openrouter)');
});

test('a baseURL carrying its own credentials is still rejected', async () => {
  const registry = new PlatformModelProviderRegistry(
    lookup(record({ baseURL: 'https://user:pass@models.internal.example/v1' })),
    { logger: () => {} },
  );
  await assert.rejects(registry.resolveById(RECORD_ID), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'MODEL_BASE_URL_INVALID');
    assert.match((error as Error).message, /cannot contain credentials/);
    return true;
  });
});

test('a disabled record never resolves', async () => {
  const registry = new PlatformModelProviderRegistry(lookup(record({ enabled: false })), {
    logger: () => {},
  });
  await assert.rejects(registry.resolveById(RECORD_ID), {
    code: 'MODEL_PROVIDER_DISABLED',
  });
});

test('a record without apiKey is a coded error, with no environment to fall back to', async () => {
  const registry = new PlatformModelProviderRegistry(lookup(record({ apiKey: undefined })), {
    logger: () => {},
  });

  // A variable named after the provider must not stand in for the missing field.
  process.env.MODEL_API_KEY = 'from-environment';
  try {
    await assert.rejects(registry.resolveById(RECORD_ID), {
      code: 'MISSING_MODEL_CREDENTIAL',
    });
  } finally {
    delete process.env.MODEL_API_KEY;
  }
});

test('unsupported providers, auth kinds, and wire fields are rejected at write', () => {
  const writable = {
    name: 'primary',
    model: 'zai.glm-5',
    baseURL: 'https://models.internal.example/v1',
    apiKey: 'test-key',
    auth: { kind: 'bearer' as const },
    capabilities,
    enabled: true,
  };

  const bedrock = parseModelProviderInput({ ...writable, provider: 'bedrock' });
  assert.throws(
    () => assertRuntimeSupport(bedrock),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNSUPPORTED_MODEL_PROVIDER');
      assert.match((error as Error).message, /'provider'/);
      assert.match((error as Error).message, /bedrock/);
      return true;
    },
  );

  const noAuth = parseModelProviderInput({
    ...writable,
    provider: 'openai-compatible',
    apiKey: undefined,
    auth: { kind: 'none' },
  });
  assert.throws(
    () => assertRuntimeSupport(noAuth),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNSUPPORTED_MODEL_AUTH_KIND');
      assert.match((error as Error).message, /'auth\.kind'/);
      return true;
    },
  );

  // `reasoningField` is honoured now: the adapter reads that delta field.
  const reasoning = parseModelProviderInput({
    ...writable,
    provider: 'openai-compatible',
    wire: { reasoningField: 'reasoning_content' },
  });
  assert.doesNotThrow(() => assertRuntimeSupport(reasoning));

  const usageReporting = parseModelProviderInput({
    ...writable,
    provider: 'openai-compatible',
    wire: { usageReporting: 'cumulative' },
  });
  assert.throws(
    () => assertRuntimeSupport(usageReporting),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNSUPPORTED_MODEL_WIRE_FIELD');
      assert.match((error as Error).message, /'wire\.usageReporting'/);
      return true;
    },
  );

  const headerAuth = parseModelProviderInput({
    ...writable,
    provider: 'openai-compatible',
    auth: { kind: 'header', headerName: 'api-key' },
  });
  assert.throws(() => assertRuntimeSupport(headerAuth), {
    code: 'UNSUPPORTED_MODEL_AUTH_KIND',
  });

  // maxTokensField is the one honoured wire field.
  assert.doesNotThrow(() =>
    assertRuntimeSupport(
      parseModelProviderInput({
        ...writable,
        provider: 'openai-compatible',
        wire: { maxTokensField: 'max_completion_tokens' },
      }),
    ),
  );
});

test('schema enforces baseURL, apiKey, and headerName preconditions', () => {
  const base = {
    name: 'primary',
    model: 'zai.glm-5',
    capabilities,
    enabled: true,
  };
  // openai-compatible requires an explicit baseURL.
  assert.throws(() =>
    parseModelProviderInput({
      ...base,
      provider: 'openai-compatible',
      apiKey: 'test-key',
      auth: { kind: 'bearer' },
    }),
  );
  assert.doesNotThrow(() =>
    parseModelProviderInput({
      ...base,
      provider: 'openrouter',
      apiKey: 'test-key',
      auth: { kind: 'bearer' },
    }),
  );
  // bearer auth requires the credential.
  assert.throws(() =>
    parseModelProviderInput({
      ...base,
      provider: 'openrouter',
      auth: { kind: 'bearer' },
    }),
  );
  assert.throws(() =>
    parseModelProviderInput({
      ...base,
      provider: 'openrouter',
      auth: { kind: 'header' },
    }),
  );
  // auth.kind none must not carry one.
  assert.throws(() =>
    parseModelProviderInput({
      ...base,
      provider: 'openrouter',
      apiKey: 'test-key',
      auth: { kind: 'none' },
    }),
  );
});

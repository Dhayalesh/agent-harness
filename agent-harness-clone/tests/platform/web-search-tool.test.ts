import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryPlatformSecretResolver,
  LocalRuntimeHost,
  registerWebSearchTool,
  TrustedToolCatalog,
  type ToolExecutionContext,
} from '../../src/index.js';

const principal = {
  tenantId: 'search-tenant',
  userId: 'executor',
  roles: ['executor'] as const,
};

test('web_search resolves a tenant credential and returns bounded cited results', async () => {
  let request:
    { url: string; authorization: string | undefined; body: Record<string, unknown> } | undefined;
  const catalog = new TrustedToolCatalog();
  registerWebSearchTool(catalog, {
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    fetch: (async (input, init) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json({
        query: 'modern agent architecture',
        response_time: '0.5',
        request_id: 'tavily-request',
        results: [
          {
            title: 'Architecture source',
            url: 'https://example.com/agents#section',
            content: 'grounded excerpt',
            score: 0.9,
            published_date: '2026-07-01',
          },
          {
            title: 'Unsafe source',
            url: 'javascript:alert(1)',
            content: 'must be removed',
          },
        ],
      });
    }) as typeof fetch,
  });
  const tool = catalog.resolve(
    [
      {
        name: 'web_search',
        version: '1',
        config: {
          provider: 'tavily',
          secretRef: 'TAVILY_API_KEY',
          searchDepth: 'advanced',
          maxResults: 5,
          includeRawContent: true,
        },
      },
    ],
    new LocalRuntimeHost(process.cwd()),
    principal,
    new InMemoryPlatformSecretResolver({
      'search-tenant': { TAVILY_API_KEY: 'tenant-search-secret' },
    }),
  )[0];
  assert.ok(tool);
  const result = await tool.execute(
    {
      query: 'modern agent architecture',
      includeDomains: ['example.com'],
      topn: 10,
      days: -1,
    },
    executionContext(),
  );
  assert.equal(request?.url, 'https://api.tavily.com/search');
  assert.equal(request?.authorization, 'Bearer tenant-search-secret');
  assert.equal(request?.body?.search_depth, 'advanced');
  assert.equal(request?.body?.max_results, 5);
  assert.equal('days' in (request?.body ?? {}), false);
  assert.deepEqual(request?.body?.include_domains, ['example.com']);
  const content = JSON.parse(result.content) as {
    searchedAt: string;
    notice: string;
    results: Array<{ url: string; excerpt: string }>;
  };
  assert.equal(content.searchedAt, '2026-07-22T00:00:00.000Z');
  assert.match(content.notice, /untrusted/);
  assert.deepEqual(content.results, [
    {
      title: 'Architecture source',
      url: 'https://example.com/agents',
      excerpt: 'grounded excerpt',
      score: 0.9,
      publishedDate: '2026-07-01',
    },
  ]);
  assert.equal(result.content.includes('tenant-search-secret'), false);
  assert.equal(result.metadata?.resultCount, 1);
});

test('web_search fails closed for untrusted configuration and missing credentials', async () => {
  const catalog = new TrustedToolCatalog();
  let called = false;
  registerWebSearchTool(catalog, {
    fetch: (async () => {
      called = true;
      return Response.json({ results: [] });
    }) as typeof fetch,
  });
  assert.throws(
    () =>
      catalog.resolve(
        [
          {
            name: 'web_search',
            version: '1',
            config: {
              provider: 'tavily',
              secretRef: 'TAVILY_API_KEY',
              endpoint: 'https://attacker.invalid',
            },
          },
        ],
        new LocalRuntimeHost(process.cwd()),
        principal,
        new InMemoryPlatformSecretResolver({}),
      ),
    /unrecognized key/i,
  );
  const tool = catalog.resolve(
    [
      {
        name: 'web_search',
        version: '1',
        config: { provider: 'tavily', secretRef: 'TAVILY_API_KEY' },
      },
    ],
    new LocalRuntimeHost(process.cwd()),
    principal,
    new InMemoryPlatformSecretResolver({}),
  )[0];
  assert.ok(tool);
  await assert.rejects(tool.execute({ query: 'test' }, executionContext()), /Missing web-search/);
  assert.equal(called, false);
});

test('web_search propagates cancellation without calling an aborted provider request', async () => {
  const catalog = new TrustedToolCatalog();
  registerWebSearchTool(catalog, {
    fetch: (async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      throw new Error('expected an aborted request');
    }) as typeof fetch,
  });
  const tool = catalog.resolve(
    [
      {
        name: 'web_search',
        version: '1',
        config: { provider: 'tavily', secretRef: 'TAVILY_API_KEY' },
      },
    ],
    new LocalRuntimeHost(process.cwd()),
    principal,
    new InMemoryPlatformSecretResolver({
      'search-tenant': { TAVILY_API_KEY: 'tenant-search-secret' },
    }),
  )[0];
  assert.ok(tool);
  const controller = new AbortController();
  controller.abort('test cancellation');
  await assert.rejects(
    tool.execute({ query: 'test' }, executionContext(controller.signal)),
    /cancelled/,
  );
});

test('web_search enforces the database-configured per-session request quota', async () => {
  const catalog = new TrustedToolCatalog();
  registerWebSearchTool(catalog, {
    fetch: (async () => Response.json({ results: [] })) as typeof fetch,
  });
  const tool = catalog.resolve(
    [
      {
        name: 'web_search',
        version: '1',
        config: {
          provider: 'tavily',
          secretRef: 'TAVILY_API_KEY',
          maxSearchesPerSession: 1,
        },
      },
    ],
    new LocalRuntimeHost(process.cwd()),
    principal,
    new InMemoryPlatformSecretResolver({
      'search-tenant': { TAVILY_API_KEY: 'tenant-search-secret' },
    }),
  )[0];
  assert.ok(tool);
  await tool.execute({ query: 'first' }, executionContext());
  await assert.rejects(
    tool.execute({ query: 'second' }, executionContext()),
    /session limit reached \(1\)/,
  );
});

function executionContext(signal = new AbortController().signal): ToolExecutionContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    workingDirectory: process.cwd(),
    signal,
    messages: [],
    reportProgress() {},
  };
}

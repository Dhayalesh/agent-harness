import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTavilySearchProvider,
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  htmlToReadableText,
  isNonPublicHost,
  isSameSiteRedirect,
  type Tool,
  type ToolExecutionContext,
  type WebSearchProvider,
} from '../../src/index.js';

function executionContext(signal = new AbortController().signal): ToolExecutionContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    workingDirectory: process.cwd(),
    signal,
    messages: [],
    reportProgress() {
      // Progress is observable through session events elsewhere.
    },
  };
}

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function run<Input>(tool: Tool<Input>, input: unknown, signal?: AbortSignal) {
  const parsed = tool.inputSchema.parse(input);
  return tool.execute(parsed, executionContext(signal));
}

test('HTML is reduced to readable text with links, headings, and list structure', () => {
  const text = htmlToReadableText(
    `<html><head><title>Doc</title><style>.a{color:red}</style></head>
     <body><h2>Install</h2><p>Run&nbsp;<code>npm i</code> &amp; go.</p>
     <ul><li>First</li><li><a href="/guide">Guide</a></li></ul>
     <script>alert('x')</script></body></html>`,
    'https://example.com/docs',
  );
  assert.match(text, /^## Install/m);
  assert.match(text, /Run `npm i` & go\./);
  assert.match(text, /- First/);
  assert.match(text, /\[Guide\]\(https:\/\/example\.com\/guide\)/);
  assert.doesNotMatch(text, /alert|color:red/);
});

test('web_fetch upgrades http, extracts content, and caches the result', async () => {
  const requested: string[] = [];
  const tool = createWebFetchTool({
    fetch: async (input) => {
      requested.push(String(input));
      return htmlResponse(
        '<html><head><title>Hello</title></head><body><p>Body text</p></body></html>',
      );
    },
  });

  const first = await run(tool, { url: 'http://example.com/page' });
  assert.deepEqual(requested, ['https://example.com/page']);
  assert.match(first.content, /Fetched: https:\/\/example\.com\/page/);
  assert.match(first.content, /Title: Hello/);
  assert.match(first.content, /Body text/);
  assert.match(first.content, /untrusted/i);
  assert.equal(first.metadata?.cached, false);

  const second = await run(tool, { url: 'http://example.com/page' });
  assert.equal(requested.length, 1, 'second call must be served from cache');
  assert.equal(second.metadata?.cached, true);
});

test('web_fetch reports cross-site redirects instead of following them', async () => {
  const tool = createWebFetchTool({
    fetch: async () =>
      new Response(null, { status: 301, headers: { location: 'https://elsewhere.test/landing' } }),
  });
  const result = await run(tool, { url: 'https://example.com/start' });
  assert.match(result.content, /CROSS-SITE REDIRECT NOT FOLLOWED/);
  assert.equal(result.metadata?.redirectedTo, 'https://elsewhere.test/landing');
  assert.equal(result.metadata?.followed, false);
});

test('web_fetch follows same-site redirects including the www variant', async () => {
  const seen: string[] = [];
  const tool = createWebFetchTool({
    fetch: async (input) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://example.com/a') {
        return new Response(null, {
          status: 308,
          headers: { location: 'https://www.example.com/b' },
        });
      }
      return htmlResponse('<p>Landed</p>');
    },
  });
  const result = await run(tool, { url: 'https://example.com/a' });
  assert.deepEqual(seen, ['https://example.com/a', 'https://www.example.com/b']);
  assert.match(result.content, /Landed/);
});

test('web_fetch refuses non-public hosts, credentials, and unsupported schemes', async () => {
  const tool = createWebFetchTool({
    fetch: async () => {
      throw new Error('network must not be reached');
    },
  });
  await assert.rejects(run(tool, { url: 'https://localhost/admin' }), /non-public host/);
  await assert.rejects(run(tool, { url: 'https://127.0.0.1/admin' }), /non-public host/);
  await assert.rejects(run(tool, { url: 'https://[::1]/admin' }), /non-public host/);
  await assert.rejects(run(tool, { url: 'https://router.local/status' }), /non-public host/);
  await assert.rejects(run(tool, { url: 'https://user:pw@example.com/' }), /embed credentials/);
  await assert.rejects(run(tool, { url: 'file:///etc/passwd' }), /http and https/);

  assert.equal(isNonPublicHost('metadata.internal'), true);
  assert.equal(isNonPublicHost('example.com'), false);
  assert.equal(
    isSameSiteRedirect(new URL('https://example.com/a'), new URL('http://example.com/a')),
    false,
  );
});

test('web_fetch honours the operator host allowlist and body size ceiling', async () => {
  const allowlisted = createWebFetchTool({
    allowedHosts: ['docs.example.com'],
    fetch: async () => htmlResponse('<p>ok</p>'),
  });
  await assert.rejects(run(allowlisted, { url: 'https://other.example.org/x' }), /allowlist/);
  const permitted = await run(allowlisted, { url: 'https://docs.example.com/x' });
  assert.match(permitted.content, /ok/);

  const bounded = createWebFetchTool({
    maxContentBytes: 16,
    fetch: async () => htmlResponse('<p>'.concat('x'.repeat(500), '</p>')),
  });
  await assert.rejects(run(bounded, { url: 'https://example.com/big' }), /byte limit/);
});

test('web_fetch truncates long content and applies an optional summarizer', async () => {
  const truncating = createWebFetchTool({
    maxTextChars: 20,
    fetch: async () => htmlResponse(`<p>${'y'.repeat(400)}</p>`),
  });
  const truncated = await run(truncating, { url: 'https://example.com/long' });
  assert.equal(truncated.metadata?.truncated, true);
  assert.match(truncated.content, /Content truncated to 20 characters/);

  const summarizing = createWebFetchTool({
    fetch: async () => htmlResponse('<p>alpha beta</p>'),
    summarize: async ({ prompt, content }) => `summary(${prompt}):${content}`,
  });
  const summarized = await run(summarizing, {
    url: 'https://example.com/doc',
    prompt: 'what is here',
  });
  assert.match(summarized.content, /summary\(what is here\):alpha beta/);
  assert.equal(summarized.metadata?.summarized, true);
});

test('web_search returns bounded cited hits and enforces its session quota', async () => {
  const provider: WebSearchProvider = {
    name: 'stub',
    async search(request) {
      return {
        requestId: 'req-1',
        hits: [
          {
            title: 'Result one',
            url: 'https://example.com/one#frag',
            excerpt: 'e'.repeat(50),
            score: 0.9,
            publishedDate: '2026-01-01',
          },
          { title: 'Result two', url: 'https://example.com/two', excerpt: 'f'.repeat(50) },
        ].slice(0, request.maxResults),
      };
    },
  };
  const tool = createWebSearchTool({
    provider,
    maxExcerptChars: 10,
    maxTotalChars: 15,
    maxSearchesPerSession: 1,
    now: () => new Date('2026-07-27T00:00:00.000Z'),
  });

  const result = await run(tool, { query: 'agent harness' });
  const payload = JSON.parse(result.content) as {
    query: string;
    notice: string;
    searchedAt: string;
    results: Array<{ title: string; url: string; excerpt: string }>;
  };
  assert.equal(payload.query, 'agent harness');
  assert.equal(payload.searchedAt, '2026-07-27T00:00:00.000Z');
  assert.match(payload.notice, /untrusted/i);
  assert.equal(payload.results[0]?.excerpt.length, 10);
  assert.equal(payload.results[1]?.excerpt.length, 5, 'total budget must bound later hits');
  assert.equal(result.metadata?.provider, 'stub');
  assert.equal(result.metadata?.searchesRemaining, 0);

  await assert.rejects(run(tool, { query: 'second search' }), /limit reached/);
});

test('web_search rejects contradictory and malformed domain filters', () => {
  const tool = createWebSearchTool({
    provider: { name: 'stub', search: async () => ({ hits: [] }) },
  });
  assert.throws(() =>
    tool.inputSchema.parse({
      query: 'test',
      allowedDomains: ['example.com'],
      blockedDomains: ['other.com'],
    }),
  );
  assert.throws(() => tool.inputSchema.parse({ query: 'test', allowedDomains: ['not a domain'] }));
  assert.throws(() => tool.inputSchema.parse({ query: 'x' }));
  assert.deepEqual(
    tool.inputSchema.parse({ query: 'test', allowedDomains: ['docs.example.com'] }).allowedDomains,
    ['docs.example.com'],
  );
});

test('Tavily provider maps the documented response and sanitizes failures', async () => {
  let body: Record<string, unknown> = {};
  const provider = createTavilySearchProvider({
    apiKey: 'search-key',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          request_id: 'tavily-1',
          response_time: '0.4',
          results: [
            { title: 'Hit', url: 'https://example.com/a#x', content: 'excerpt', score: 0.5 },
            { title: 'Bad scheme', url: 'javascript:alert(1)', content: 'ignored' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const response = await provider.search({
    query: 'harness',
    maxResults: 3,
    signal: new AbortController().signal,
    allowedDomains: ['example.com'],
  });
  assert.equal(body.max_results, 3);
  assert.deepEqual(body.include_domains, ['example.com']);
  assert.equal(response.requestId, 'tavily-1');
  assert.deepEqual(response.hits, [
    { title: 'Hit', url: 'https://example.com/a', excerpt: 'excerpt', score: 0.5 },
  ]);

  const failing = createTavilySearchProvider({
    apiKey: 'search-key',
    fetch: async () => new Response('Bearer search-key rejected', { status: 401 }),
  });
  await assert.rejects(
    failing.search({ query: 'x', maxResults: 1, signal: new AbortController().signal }),
    (error: unknown) =>
      error instanceof Error &&
      /provider failed \(401\)/.test(error.message) &&
      !error.message.includes('search-key'),
  );
});

test('createWebTools registers fetch always and search only with a provider', (t) => {
  const previousKey = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
  });

  const withoutSearch = createWebTools();
  assert.deepEqual(
    withoutSearch.map((tool) => tool.name),
    ['web_fetch'],
  );
  assert.equal(withoutSearch[0]?.kind, 'network');

  const withSearch = createWebTools({
    searchProvider: { name: 'stub', search: async () => ({ hits: [] }) },
  });
  assert.deepEqual(
    withSearch.map((tool) => tool.name),
    ['web_fetch', 'web_search'],
  );
  assert.deepEqual(
    createWebTools({
      fetch: false,
      searchProvider: { name: 'stub', search: async () => ({ hits: [] }) },
    }).map((tool) => tool.name),
    ['web_search'],
  );
});

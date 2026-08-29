import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  createBrowserUseTool,
  resolveSystemChromium,
  type ToolExecutionContext,
} from '../../src/index.js';

/**
 * These tests drive a real Chromium instance against a real local HTTP
 * server — no mocked transport, matching this repo's convention of exercising
 * real behavior rather than stubs (see the README on the test suite). They are
 * skipped outright when no Chromium-family binary is on the machine running
 * them, the same "absent rather than failing" contract `createBrowserUseTool`
 * itself has.
 */
const chromiumAvailable = resolveSystemChromium() !== undefined;

function executionContext(
  onProgress?: (message: string, data?: Record<string, unknown>) => void,
): ToolExecutionContext {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    turnId: 'turn',
    toolCallId: 'call',
    workingDirectory: process.cwd(),
    signal: new AbortController().signal,
    messages: [],
    reportProgress(message, data) {
      onProgress?.(message, data);
    },
  };
}

async function startTestServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html>
<head><title>Test page</title></head>
<body>
  <h1>Test page</h1>
  <input id="query" placeholder="Search" />
  <button id="go" onclick="document.getElementById('result').textContent = 'searched: ' + document.getElementById('query').value">Search</button>
  <p id="result"></p>
  <a href="#" id="link">A link</a>
</body>
</html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server };
}

test('createBrowserUseTool returns undefined without a usable browser binary', () => {
  const tool = createBrowserUseTool({ executablePath: '/no/such/browser' });
  assert.equal(tool, undefined);
});

test('checkPermissions denies navigate to a non-public host by default', async () => {
  const tool = createBrowserUseTool();
  assert.ok(tool, 'expected a Chromium binary on this machine for this test');
  const check = await tool.checkPermissions?.(
    { action: 'navigate', url: 'http://127.0.0.1:9/' },
    { sessionId: 'session', workingDirectory: process.cwd() },
  );
  assert.equal(check?.decision, 'deny');
});

test(
  'browser_use navigates, reads, types, clicks, and reports a live-view VNC URL',
  { skip: !chromiumAvailable && 'no Chromium-family binary found on this machine' },
  async (t) => {
    const { url, server } = await startTestServer();
    t.after(() => server.close());

    const tool = createBrowserUseTool({
      allowPrivateHosts: true,
      allowInsecureHttp: true,
      idleTimeoutMs: 2_000,
    });
    assert.ok(tool);

    const progressEvents: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const context = executionContext((message, data) =>
      progressEvents.push({ message, ...(data === undefined ? {} : { data }) }),
    );

    const nav = await tool.execute({ action: 'navigate', url }, context);
    assert.equal(nav.isError, undefined);
    assert.match(nav.content, /Title: Test page/);

    const firstRead = await tool.execute({ action: 'read' }, context);
    assert.match(firstRead.content, /Search/);
    assert.match(firstRead.content, /button/);

    const typed = await tool.execute({ action: 'type', selector: '#query', text: 'MARA' }, context);
    assert.equal(typed.isError, undefined);

    const clicked = await tool.execute({ action: 'click', selector: '#go' }, context);
    assert.equal(clicked.isError, undefined);

    const secondRead = await tool.execute({ action: 'read' }, context);
    assert.match(secondRead.content, /searched: MARA/);

    // `vncWsUrl` is a plain field on the session, not an async lookup, so
    // every one of the 5 execute() calls above reports it at the end (`navigate`
    // also fires its own pre-navigation "Navigating" progress event with no
    // `vncWsUrl`, same as before this tool had a live view at all).
    const withVncUrl = progressEvents.filter((event) => event.data?.vncWsUrl);
    assert.equal(withVncUrl.length, 5);
    const vncWsUrls = new Set(withVncUrl.map((event) => event.data?.vncWsUrl));
    assert.equal(vncWsUrls.size, 1, 'expected the same live-view URL across the whole session');
    const [vncWsUrl] = vncWsUrls;
    assert.match(vncWsUrl as string, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
  },
);

test(
  'browser_use reports a text error rather than throwing when a selector does not exist',
  { skip: !chromiumAvailable && 'no Chromium-family binary found on this machine' },
  async (t) => {
    const { url, server } = await startTestServer();
    t.after(() => server.close());

    const tool = createBrowserUseTool({
      allowPrivateHosts: true,
      allowInsecureHttp: true,
      actionTimeoutMs: 500,
      idleTimeoutMs: 2_000,
    });
    assert.ok(tool);
    const context = executionContext();

    await tool.execute({ action: 'navigate', url }, context);
    const result = await tool.execute({ action: 'click', selector: '#does-not-exist' }, context);
    assert.equal(result.isError, true);
    assert.match(result.content, /click failed/);
  },
);

test(
  'navigate with newTab switches the session to a new tab, leaving the original navigable behavior alone',
  { skip: !chromiumAvailable && 'no Chromium-family binary found on this machine' },
  async (t) => {
    const first = await startTestServer();
    t.after(() => first.server.close());
    const second = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        '<!doctype html><html><head><title>Second tab</title></head><body>Second</body></html>',
      );
    });
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
    const secondPort = (second.address() as AddressInfo).port;
    t.after(() => second.close());

    const tool = createBrowserUseTool({
      allowPrivateHosts: true,
      allowInsecureHttp: true,
      idleTimeoutMs: 2_000,
    });
    assert.ok(tool);
    const context = executionContext();

    const firstNav = await tool.execute({ action: 'navigate', url: first.url }, context);
    assert.match(firstNav.content, /Title: Test page/);

    const secondNav = await tool.execute(
      { action: 'navigate', url: `http://127.0.0.1:${secondPort}/`, newTab: true },
      context,
    );
    assert.equal(secondNav.isError, undefined);
    assert.match(secondNav.content, /Title: Second tab/);

    // The session now drives the new tab, not the original one — the same
    // way a human who just opened a new tab keeps typing into that one.
    const read = await tool.execute({ action: 'read' }, context);
    assert.match(read.content, /Title: Second tab/);
  },
);

test(
  'read warns about a full-page overlay before a click on it can time out',
  { skip: !chromiumAvailable && 'no Chromium-family binary found on this machine' },
  async (t) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html>
<html>
<head><title>Overlay page</title></head>
<body>
  <button id="hidden-button">Underneath</button>
  <div id="modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);">
    <button id="close">Close</button>
  </div>
</body>
</html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    t.after(() => server.close());

    const tool = createBrowserUseTool({
      allowPrivateHosts: true,
      allowInsecureHttp: true,
      idleTimeoutMs: 2_000,
    });
    assert.ok(tool);
    const context = executionContext();

    await tool.execute({ action: 'navigate', url: `http://127.0.0.1:${port}/` }, context);
    const read = await tool.execute({ action: 'read' }, context);
    assert.match(read.content, /overlay is covering the page/);
    assert.match(read.content, /#modal/);
  },
);

test(
  'read reports the scroll position, which advances after scroll even though the page text does not',
  { skip: !chromiumAvailable && 'no Chromium-family binary found on this machine' },
  async (t) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><html><head><title>Tall page</title></head>` +
          `<body><div style="height:4000px">Same text throughout</div></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    t.after(() => server.close());

    const tool = createBrowserUseTool({
      allowPrivateHosts: true,
      allowInsecureHttp: true,
      idleTimeoutMs: 2_000,
    });
    assert.ok(tool);
    const context = executionContext();

    await tool.execute({ action: 'navigate', url: `http://127.0.0.1:${port}/` }, context);
    const beforeScroll = await tool.execute({ action: 'read' }, context);
    assert.match(beforeScroll.content, /Scroll position: 0px from top/);

    await tool.execute({ action: 'scroll', direction: 'down', amount: 800 }, context);
    const afterScroll = await tool.execute({ action: 'read' }, context);
    assert.match(afterScroll.content, /Scroll position: 800px from top/);
    // The reported page text is unchanged by the scroll — this is what a
    // model reading only the text (not the scroll line) would misread as
    // "scrolling isn't doing anything."
    assert.match(afterScroll.content, /Same text throughout/);
  },
);

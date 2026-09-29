import assert from 'node:assert/strict';
import test from 'node:test';
import { McpConnection } from '../../src/mcp/client.js';
import { EdgeClientTransport } from '../../src/mcp/edge-transport.js';
import { parseInvocationPayload } from '../../src/headless/payload.js';
import {
  parseMcpServerInput,
  parseMcpServerRecord,
} from '../../src/platform/mcp-server-definitions.js';
import { PlatformMcpServerRegistry } from '../../src/platform/mcp-server-registry.js';

const GUI_URL = 'wss://gui-edge-server.duckdns.org/ws';
const EMAIL = 'runtime@example.test';
const capabilities = {
  tools: true,
  resources: false,
  prompts: false,
  elicitation: false,
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
};
const gui = {
  name: 'sapgui',
  transport: 'edge' as const,
  url: GUI_URL,
  mcpId: 'sapgui',
  auth: { kind: 'none' as const },
  capabilities,
  enabled: true,
};

type Envelope = {
  version: number;
  type: string;
  requestId: string;
  email?: string;
  payload: { mcpId: string; message: Record<string, unknown> };
};

class GuiWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: GuiWebSocket[] = [];
  static autoReply = false;
  static failOpen = false;
  readonly sent: Envelope[] = [];
  readonly url: string;
  readyState = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    GuiWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (GuiWebSocket.failOpen) {
        this.dispatchEvent(new Event('error'));
        return;
      }
      this.readyState = GuiWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    const envelope = JSON.parse(data) as Envelope;
    this.sent.push(envelope);
    if (!GuiWebSocket.autoReply) return;
    const message = envelope.payload.message;
    if (message.method === 'initialize') {
      this.reply(envelope, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sapgui.mcp', version: '1.0.0' },
        },
      });
    } else if (message.method === 'tools/list') {
      this.reply(envelope, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: ['sap_list_connections', 'sap_take_screenshot'].map((name) => ({
            name,
            inputSchema: { type: 'object', properties: {} },
          })),
        },
      });
    } else if (message.method === 'tools/call') {
      this.reply(envelope, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            { type: 'text', text: 'Screenshot ready' },
            { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
          ],
          structuredContent: { captured: true },
        },
      });
    }
  }

  reply(envelope: Envelope, message: unknown): void {
    this.deliver({
      version: 1,
      type: 'mcp.response',
      requestId: envelope.requestId,
      payload: { message },
    });
  }

  error(envelope: Envelope, code: string): void {
    this.deliver({
      version: 1,
      type: 'edge.error',
      requestId: envelope.requestId,
      payload: { code },
    });
  }

  deliver(envelope: unknown): void {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify(envelope),
        }),
      ),
    );
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

test('SAP GUI Edge configuration parses without browser identity fields', () => {
  assert.equal(parseMcpServerInput(gui).mcpId, 'sapgui');
  assert.throws(() => parseMcpServerInput({ ...gui, email: EMAIL }));
  assert.throws(() => parseMcpServerInput({ ...gui, mcpId: '' }));
  const payload = parseInvocationPayload({
    prompt: 'List SAP GUI tools',
    agent: { name: 'gui-test', systemPrompt: 'Use available tools.', tools: [] },
    modelProvider: {
      provider: 'openai-compatible',
      model: 'fake-model',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'test-key',
    },
    mcpServers: [{ name: 'sapgui', transport: 'edge', url: GUI_URL, mcpId: 'sapgui' }],
  });
  assert.equal(payload.mcpServers[0]?.url, GUI_URL);
});

test('GUI relay correlates concurrent JSON-RPC requests and propagates offline errors', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = GuiWebSocket as unknown as typeof WebSocket;
  GuiWebSocket.instances = [];
  GuiWebSocket.autoReply = false;
  try {
    const transport = new EdgeClientTransport(new URL(GUI_URL), 'sapgui', EMAIL, 'sapgui');
    const received: unknown[] = [];
    let closed = false;
    transport.onmessage = (message) => received.push(message);
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();
    const socket = GuiWebSocket.instances[0]!;
    assert.equal(socket.url, GUI_URL);
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await transport.send({ jsonrpc: '2.0', id: 8, method: 'ping' });
    assert.notEqual(socket.sent[0]?.requestId, socket.sent[1]?.requestId);
    assert.deepEqual(socket.sent[0], {
      version: 1,
      type: 'mcp.request',
      requestId: socket.sent[0]?.requestId,
      email: EMAIL,
      payload: { mcpId: 'sapgui', message: { jsonrpc: '2.0', id: 7, method: 'ping' } },
    });
    socket.reply(socket.sent[1]!, { jsonrpc: '2.0', id: 8, result: {} });
    socket.reply(socket.sent[0]!, { jsonrpc: '2.0', id: 7, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [
      { jsonrpc: '2.0', id: 8, result: {} },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]);

    await transport.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    socket.error(socket.sent[2]!, 'device_offline');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received[2], {
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32000, message: 'device_offline' },
    });
    assert.equal(closed, false);

    await transport.send({ jsonrpc: '2.0', id: 10, method: 'ping' });
    socket.reply(socket.sent[3]!, {
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32603, message: 'SAP GUI unavailable' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received[3], {
      jsonrpc: '2.0',
      id: 10,
      error: { code: -32603, message: 'SAP GUI unavailable' },
    });

    await transport.send({ jsonrpc: '2.0', id: 12, method: 'ping' });
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 12 },
    });
    assert.equal(socket.sent.length, 5);
    socket.reply(socket.sent[4]!, { jsonrpc: '2.0', id: 12, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 4);
    assert.equal(closed, false);

    await transport.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
    socket.reply(socket.sent[5]!, { jsonrpc: '2.0', id: 999, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
  } finally {
    globalThis.WebSocket = original;
  }
});

test('GUI registry initializes, forwards notification, discovers tools, and preserves image blocks', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = GuiWebSocket as unknown as typeof WebSocket;
  GuiWebSocket.instances = [];
  GuiWebSocket.autoReply = true;
  try {
    const logs: unknown[] = [];
    const record = parseMcpServerRecord({
      ...gui,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'test',
    });
    const registry = new PlatformMcpServerRegistry(
      {
        async get() {
          return record;
        },
        async getByName() {
          return record;
        },
        async listAutoConnect() {
          return [record];
        },
      },
      {
        environment: { EDGE_USER_EMAIL: 'adt@example.test', GUI_EDGE_USER_EMAIL: EMAIL },
        logSink: {
          log(entry) {
            logs.push(entry);
          },
        },
      },
    );
    const connection = await registry.resolveRecord(record);
    try {
      const tools = await connection.tools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['mcp__sapgui__sap_list_connections', 'mcp__sapgui__sap_take_screenshot'],
      );
      const screenshot = tools[1]!;
      const result = await screenshot.execute(
        { connection: 'Test SAP' },
        {
          sessionId: 'session',
          turnId: 'turn',
          toolCallId: 'call',
          workingDirectory: process.cwd(),
          signal: new AbortController().signal,
          messages: [],
          reportProgress() {},
        },
      );
      assert.deepEqual(result.metadata?.contentBlocks, [
        { type: 'text', text: 'Screenshot ready' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ]);
      assert.deepEqual(result.metadata?.structuredContent, { captured: true });
      const sent = GuiWebSocket.instances[0]!.sent;
      assert.deepEqual(
        sent.map((item) => item.payload.message.method),
        ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
      );
      const callParams = sent[3]?.payload.message.params as Record<string, unknown>;
      assert.deepEqual(
        { name: callParams.name, arguments: callParams.arguments },
        {
          name: 'sap_take_screenshot',
          arguments: { connection: 'Test SAP' },
        },
      );
      assert.equal(
        sent.every((item) => item.type === 'mcp.request'),
        true,
      );
      assert.equal(
        sent.every((item) => item.email === EMAIL),
        true,
      );
      const logged = JSON.stringify(logs);
      assert.equal(logged.includes('Test SAP'), false);
      assert.equal(logged.includes('aGVsbG8='), false);
      assert.equal(logged.includes(EMAIL), false);
    } finally {
      await connection.close();
    }
    // A subsequent agent run creates a fresh connection after the prior one closes.
    const reconnected = await McpConnection.connectEdge(
      'sapgui',
      new URL(GUI_URL),
      'sapgui',
      EMAIL,
    );
    await reconnected.close();
    assert.equal(GuiWebSocket.instances.length, 2);
  } finally {
    globalThis.WebSocket = original;
  }
});

test('GUI relay connection failure does not use the ADT endpoint', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = GuiWebSocket as unknown as typeof WebSocket;
  GuiWebSocket.instances = [];
  GuiWebSocket.failOpen = true;
  try {
    await assert.rejects(
      McpConnection.connectEdge('sapgui', new URL(GUI_URL), 'sapgui', EMAIL),
      /Edge WebSocket (connection failed|closed during connection)/,
    );
    assert.equal(GuiWebSocket.instances[0]?.url, GUI_URL);
    assert.equal(GuiWebSocket.instances.length, 1);
  } finally {
    GuiWebSocket.failOpen = false;
    globalThis.WebSocket = original;
  }
});

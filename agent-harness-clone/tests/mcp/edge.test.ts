import assert from 'node:assert/strict';
import test from 'node:test';
import { EdgeClientTransport } from '../../src/mcp/edge-transport.js';
import { resolveInlineAgent } from '../../src/headless/inline-agent.js';
import { parseInvocationPayload } from '../../src/headless/payload.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PlatformMcpServerRegistry } from '../../src/platform/mcp-server-registry.js';
import {
  parseMcpServerInput,
  parseMcpServerRecord,
} from '../../src/platform/mcp-server-definitions.js';

const URL_STRING = 'wss://edge-server-conector.duckdns.org/harness/ws';
const capabilities = {
  tools: true,
  resources: false,
  prompts: false,
  elicitation: false,
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
};
const input = {
  name: 'sap-adt',
  transport: 'edge' as const,
  url: URL_STRING,
  mcpId: 'sap-adt',
  auth: { kind: 'none' as const },
  capabilities,
  enabled: true,
};

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readyState = 0;
  constructor(_url: string | URL) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  send(data: string): void {
    const envelope = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(envelope);
    const route = envelope.payload as { message: { id: number; method: string } };
    if (route.message.method === 'initialize') {
      this.reply(envelope, {
        jsonrpc: '2.0',
        id: route.message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sap-adt', version: '1.0.0' },
        },
      });
    } else if (route.message.method === 'tools/list') {
      this.reply(envelope, {
        jsonrpc: '2.0',
        id: route.message.id,
        result: {
          tools: Array.from({ length: 206 }, (_, i) => ({
            name: `tool_${i}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        },
      });
    }
  }
  reply(envelope: Record<string, unknown>, message: unknown): void {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            version: 1,
            type: 'harness.mcp.response',
            requestId: envelope.requestId,
            payload: { message },
          }),
        }),
      ),
    );
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

test('Edge definition requires a WSS URL and MCP ID and rejects client credentials', () => {
  assert.equal(parseMcpServerInput(input).mcpId, 'sap-adt');
  assert.throws(() => parseMcpServerInput({ ...input, mcpId: undefined }));
  assert.throws(() => parseMcpServerInput({ ...input, url: 'https://example.com/harness/ws' }));
  assert.throws(() => parseMcpServerInput({ ...input, apiKey: 'untrusted' }));
  assert.throws(() => parseMcpServerInput({ ...input, headers: { Authorization: 'untrusted' } }));
});

test('Edge request IDs correlate responses independently of JSON-RPC IDs', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  try {
    const transport = new EdgeClientTransport(
      new URL(URL_STRING),
      'sap-adt',
      'user@company.com',
      'sap-adt',
    );
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    const socket = (transport as unknown as { socket: MockWebSocket }).socket;
    await transport.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await transport.send({ jsonrpc: '2.0', id: 8, method: 'ping' });
    assert.equal(socket.sent.length, 2);
    assert.notEqual(socket.sent[0]?.requestId, socket.sent[1]?.requestId);
    assert.deepEqual(socket.sent[0]?.payload, {
      email: 'user@company.com',
      mcpId: 'sap-adt',
      message: { jsonrpc: '2.0', id: 7, method: 'ping' },
    });
    socket.reply(socket.sent[1]!, { jsonrpc: '2.0', id: 8, result: {} });
    socket.reply(socket.sent[0]!, { jsonrpc: '2.0', id: 7, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [
      { jsonrpc: '2.0', id: 8, result: {} },
      { jsonrpc: '2.0', id: 7, result: {} },
    ]);
    await transport.close();
  } finally {
    globalThis.WebSocket = original;
  }
});

test('Edge relay errors keep the MCP id and malformed replies close the connection', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  try {
    const transport = new EdgeClientTransport(
      new URL(URL_STRING),
      'sap-adt',
      'user@company.com',
      'sap-adt',
    );
    const received: unknown[] = [];
    let closed = false;
    transport.onmessage = (message) => received.push(message);
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();
    const socket = (transport as unknown as { socket: MockWebSocket }).socket;
    await transport.send({ jsonrpc: '2.0', id: 19, method: 'ping' });
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          version: 1,
          type: 'harness.mcp.error',
          requestId: socket.sent[0]?.requestId,
          payload: { error: 'device offline' },
        }),
      }),
    );
    assert.deepEqual(received, [
      {
        jsonrpc: '2.0',
        id: 19,
        error: { code: -32000, message: 'device offline' },
      },
    ]);
    await transport.send({ jsonrpc: '2.0', id: 20, method: 'ping' });
    socket.reply(socket.sent[1]!, { jsonrpc: '2.0', id: 999, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
  } finally {
    globalThis.WebSocket = original;
  }
});

test('registry initializes through Edge and discovers 206 normal MCP tools', async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  try {
    const record = parseMcpServerRecord({
      ...input,
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
      { environment: { EDGE_USER_EMAIL: 'user@company.com' } },
    );
    const connection = await registry.resolveRecord(record);
    try {
      const tools = await connection.tools();
      assert.equal(tools.length, 206);
      assert.equal(tools[0]?.name, 'mcp__sap-adt__tool_0');
      const descriptors = new ToolRegistry(tools).descriptors();
      assert.equal(descriptors.length, 206);
      assert.equal(descriptors[0]?.name, 'mcp__sap-adt__tool_0');
      const socket = (connection as unknown as { transport: { socket: MockWebSocket } }).transport
        .socket;
      assert.deepEqual(
        socket.sent.map((item) => (item.payload as { message: { method: string } }).message.method),
        ['initialize', 'tools/list'],
      );
    } finally {
      await connection.close();
    }
  } finally {
    globalThis.WebSocket = original;
  }
});

test('registry requires the trusted runtime email', async () => {
  const record = parseMcpServerRecord({
    ...input,
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
    { environment: {} },
  );
  await assert.rejects(registry.resolveRecord(record), /EDGE_USER_EMAIL/);
});

test('inline agent contributes Edge tools to its existing tool list', async () => {
  const originalSocket = globalThis.WebSocket;
  const originalEmail = process.env.EDGE_USER_EMAIL;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  process.env.EDGE_USER_EMAIL = 'user@company.com';
  try {
    const payload = parseInvocationPayload({
      prompt: 'List tools',
      agent: { name: 'edge-test', systemPrompt: 'List available tools.', tools: [] },
      modelProvider: {
        provider: 'openai-compatible',
        model: 'fake-model',
        baseURL: 'http://127.0.0.1:1/v1',
        apiKey: 'test-key',
      },
      mcpServers: [{ name: 'sap-adt', transport: 'edge', url: URL_STRING, mcpId: 'sap-adt' }],
    });
    const agent = await resolveInlineAgent(payload, { localTools: [] });
    try {
      assert.equal(agent.tools.length, 206);
      assert.equal(new ToolRegistry(agent.tools).descriptors().length, 206);
    } finally {
      await agent.close();
    }
  } finally {
    globalThis.WebSocket = originalSocket;
    if (originalEmail === undefined) delete process.env.EDGE_USER_EMAIL;
    else process.env.EDGE_USER_EMAIL = originalEmail;
  }
});

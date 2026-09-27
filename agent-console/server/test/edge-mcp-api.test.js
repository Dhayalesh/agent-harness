import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Agent } from "../src/models/agent.js";
import { McpServer } from "../src/models/mcp-server.js";
import { ModelProvider } from "../src/models/model-provider.js";
import { Skill } from "../src/models/skill.js";
import { Template } from "../src/models/template.js";

const edge = {
  name: "sap-adt",
  transport: "edge",
  url: "wss://edge-server-conector.duckdns.org/harness/ws",
  mcpId: "sap-adt",
  auth: { kind: "none" },
  capabilities: {
    tools: true, resources: false, prompts: false, elicitation: false,
    connectTimeoutMs: 30_000, requestTimeoutMs: 55_000,
  },
  enabled: true,
};

function query(value) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

test("creates, lists, reads, and updates Edge MCP servers through the existing API", async (context) => {
  let stored;
  context.mock.method(McpServer, "create", async (value) => {
    stored = new McpServer({ _id: "507f1f77bcf86cd799439044", ...value });
    return stored;
  });
  context.mock.method(McpServer, "find", () => query(stored ? [stored] : []));
  context.mock.method(McpServer, "countDocuments", async () => Number(Boolean(stored)));
  context.mock.method(McpServer, "findById", () => query(stored));
  context.mock.method(ModelProvider, "find", () => query([]));
  context.mock.method(Skill, "find", () => query([]));
  context.mock.method(Template, "find", () => query([]));
  context.mock.method(McpServer.prototype, "save", async function () { return this; });
  context.mock.method(Agent, "countDocuments", async () => 0);

  const server = createApp().listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/mcp-servers`;

  const created = await fetch(base, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(edge),
  });
  assert.equal(created.status, 201);
  const { mcpServer } = await created.json();
  assert.equal(mcpServer.mcpId, "sap-adt");
  assert.equal(mcpServer.url, edge.url);
  assert.equal("email" in mcpServer, false);

  const list = await fetch(base);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).mcpServers.map((entry) => entry.transport), ["edge"]);

  const catalogue = await fetch(`http://127.0.0.1:${server.address().port}/api/catalogue`);
  assert.equal(catalogue.status, 200);
  assert.deepEqual((await catalogue.json()).mcpServers.map((entry) => entry.id), [mcpServer.id]);

  const detail = await fetch(`${base}/${mcpServer.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).mcpServer.mcpId, "sap-adt");

  const updated = await fetch(`${base}/${mcpServer.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mcpId: "sap-adt-v2" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).mcpServer.mcpId, "sap-adt-v2");
  assert.equal(stored.mcpId, "sap-adt-v2");

  const asHttp = await fetch(`${base}/${mcpServer.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transport: "http", url: "https://mcp.example.test/rpc", mcpId: null,
      auth: { kind: "bearer" }, apiKey: "http-secret", headers: {},
      command: null, args: null, env: null, wire: null,
    }),
  });
  assert.equal(asHttp.status, 200);
  const httpRecord = (await asHttp.json()).mcpServer;
  assert.equal(httpRecord.transport, "http");
  assert.equal("mcpId" in httpRecord, false);
  assert.equal(httpRecord.hasApiKey, true);

  const asEdge = await fetch(`${base}/${mcpServer.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transport: "edge", url: edge.url, mcpId: "sap-adt",
      auth: { kind: "none" }, apiKey: null, headers: null,
      command: null, args: null, env: null, wire: null,
    }),
  });
  assert.equal(asEdge.status, 200);
  const edgeRecord = (await asEdge.json()).mcpServer;
  assert.equal(edgeRecord.transport, "edge");
  assert.equal(edgeRecord.mcpId, "sap-adt");
  assert.equal(edgeRecord.hasApiKey, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "../src/models/mcp-server.js";
import { ModelProvider } from "../src/models/model-provider.js";
import {
  agentProviderLimitIssue,
  agentStreamingIssue,
  mcpConfigurationIssue,
  safeMcpServer,
  safeModelProvider,
} from "../src/services/platform.js";

const timestamp = "2026-08-06T09:30:00.000Z";

test("serializes model providers without credential or header values", () => {
  const provider = new ModelProvider({
    _id: "507f1f77bcf86cd799439011",
    name: "nvidia-model",
    provider: "openai-compatible",
    model: "meta/llama-3.3-70b-instruct",
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey: "provider-secret",
    auth: { kind: "bearer" },
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      supportsTools: true,
      supportsStreaming: true,
      supportsReasoning: false,
      reportsCost: false,
    },
    headers: {
      "X-OpenRouter-Title": "Agent Console",
      "HTTP-Referer": "https://example.test",
    },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });

  for (const value of [safeModelProvider(provider), provider.toJSON()]) {
    assert.equal(value.hasApiKey, true);
    assert.equal(value.hasHeaders, true);
    assert.deepEqual(value.headerNames, ["HTTP-Referer", "X-OpenRouter-Title"]);
    assert.equal(Object.hasOwn(value, "apiKey"), false);
    assert.equal(Object.hasOwn(value, "headers"), false);
    assert.equal(JSON.stringify(value).includes("provider-secret"), false);
    assert.equal(JSON.stringify(value).includes("https://example.test"), false);
  }
});

test("serializes MCP servers without credential, environment, or header values", () => {
  const server = new McpServer({
    _id: "507f1f77bcf86cd799439012",
    name: "remote-tools",
    transport: "http",
    url: "https://mcp.example.test/rpc",
    apiKey: "mcp-secret",
    auth: { kind: "header", headerName: "X-MCP-Key" },
    capabilities: {
      tools: true,
      resources: true,
      prompts: false,
      elicitation: false,
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    },
    env: { PRIVATE_TOKEN: "environment-secret", PUBLIC_MODE: "production" },
    headers: { "X-Tenant": "tenant-a" },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });

  for (const value of [safeMcpServer(server), server.toJSON()]) {
    assert.equal(value.hasApiKey, true);
    assert.equal(value.hasEnv, true);
    assert.equal(value.hasHeaders, true);
    assert.deepEqual(value.envKeys, ["PRIVATE_TOKEN", "PUBLIC_MODE"]);
    assert.deepEqual(value.headerNames, ["X-Tenant"]);
    assert.equal(Object.hasOwn(value, "apiKey"), false);
    assert.equal(Object.hasOwn(value, "env"), false);
    assert.equal(Object.hasOwn(value, "headers"), false);
    assert.equal(JSON.stringify(value).includes("mcp-secret"), false);
    assert.equal(JSON.stringify(value).includes("environment-secret"), false);
    assert.equal(JSON.stringify(value).includes("tenant-a"), false);
  }
});

test("flags a Node stdio URL as an invalid MCP entry module", () => {
  const invalid = new McpServer({
    name: "quality",
    transport: "stdio",
    command: "node",
    args: ["https://quality.ktern.com/mcp"],
  });
  assert.equal(
    mcpConfigurationIssue(invalid)?.code,
    "MCP_CONFIGURATION_INVALID",
  );

  const nodeScript = new McpServer({
    name: "quality-script",
    transport: "stdio",
    command: "node",
    args: ["script.js", "https://quality.ktern.com/mcp"],
  });
  assert.equal(mcpConfigurationIssue(nodeScript), null);

  const http = new McpServer({
    name: "quality-http",
    transport: "http",
    url: "https://quality.ktern.com/mcp",
  });
  assert.equal(mcpConfigurationIssue(http), null);
});

test("flags HTTP URLs in Node package-launcher positions only", () => {
  for (const [command, args] of [
    ["npx", ["https://quality.ktern.com/mcp"]],
    ["npx.cmd", ["-y", "https://quality.ktern.com/mcp"]],
    ["npm", ["exec", "--", "https://quality.ktern.com/mcp"]],
    ["yarn", ["dlx", "https://quality.ktern.com/mcp"]],
    ["pnpm", ["dlx", "https://quality.ktern.com/mcp"]],
  ]) {
    const issue = mcpConfigurationIssue(
      new McpServer({
        name: "invalid-launcher",
        transport: "stdio",
        command,
        args,
      }),
    );
    assert.equal(issue?.code, "MCP_CONFIGURATION_INVALID");
    assert.match(issue.message, /package or entry command/);
  }

  const validPackageArgument = new McpServer({
    name: "valid-package-argument",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@ktern.ai/abap-adt-mcp-v2", "https://quality.ktern.com/mcp"],
  });
  assert.equal(mcpConfigurationIssue(validPackageArgument), null);

  const combined = new McpServer({
    name: "combined-npx-argument",
    transport: "stdio",
    command: "npx",
    args: ["-y @ktern.ai/abap-adt-mcp-v2 --transport=stdio"],
  });
  assert.equal(
    mcpConfigurationIssue(combined)?.code,
    "MCP_CONFIGURATION_INVALID",
  );
});

test("redacts unsafe endpoint components from legacy resource responses", () => {
  const provider = new ModelProvider({
    _id: "507f1f77bcf86cd799439014",
    name: "legacy-provider",
    baseURL: "https://user:password@models.example.test/v1?token=secret#private",
  });
  const safeProvider = safeModelProvider(provider);
  assert.equal(safeProvider.baseURL, "https://models.example.test/v1");
  assert.equal(safeProvider.baseURLRedacted, true);
  assert.equal(JSON.stringify(safeProvider).includes("password"), false);
  assert.equal(JSON.stringify(safeProvider).includes("secret"), false);

  const server = new McpServer({
    _id: "507f1f77bcf86cd799439015",
    name: "legacy-server",
    transport: "http",
    url: "https://user:password@mcp.example.test/rpc?api_key=secret#private",
  });
  const safeServer = safeMcpServer(server);
  assert.equal(safeServer.url, "https://mcp.example.test/rpc");
  assert.equal(safeServer.urlRedacted, true);
  assert.equal(JSON.stringify(safeServer).includes("password"), false);
  assert.equal(JSON.stringify(safeServer).includes("secret"), false);

  for (const baseURL of ["data:text/plain,TOPSECRET", "file:///private/credential"]) {
    const unsafe = safeModelProvider(
      new ModelProvider({
        _id: "507f1f77bcf86cd799439016",
        name: "unsafe-scheme",
        baseURL,
      }),
    );
    assert.equal(Object.hasOwn(unsafe, "baseURL"), false);
    assert.equal(unsafe.baseURLRedacted, true);
    assert.equal(JSON.stringify(unsafe).includes("TOPSECRET"), false);
    assert.equal(JSON.stringify(unsafe).includes("credential"), false);
  }
});

test("keeps HTTP process arguments absent when they were not stored", () => {
  const server = new McpServer({
    name: "remote",
    transport: "http",
    url: "https://mcp.example.test/rpc",
  });
  assert.equal(server.toObject({ transform: false }).args, undefined);
});

test("reports agent token limits that exceed the referenced provider", () => {
  const provider = {
    capabilities: { contextWindow: 100_000, maxOutputTokens: 10_000 },
  };
  assert.equal(
    agentProviderLimitIssue(
      { limits: { maxTurns: 12, maxOutputTokens: 12_000 } },
      provider,
    )?.code,
    "MODEL_LIMITS_INVALID",
  );
  assert.equal(
    agentProviderLimitIssue(
      {
        limits: {
          maxTurns: 12,
          maxInputTokens: 95_000,
          maxOutputTokens: 8_000,
        },
      },
      provider,
    )?.code,
    "MODEL_LIMITS_INVALID",
  );
  assert.equal(
    agentProviderLimitIssue(
      {
        limits: {
          maxTurns: 12,
          maxInputTokens: 90_000,
          maxOutputTokens: 10_000,
        },
      },
      provider,
    ),
    null,
  );
});

test("reports a streaming agent pointed at a provider that cannot stream", () => {
  const streaming = { supportsStreaming: true };
  const buffered = { supportsStreaming: false };

  assert.equal(
    agentStreamingIssue({ stream: true }, { capabilities: buffered })?.code,
    "MODEL_PROVIDER_NO_STREAMING",
  );
  assert.equal(
    agentStreamingIssue({ stream: true }, { capabilities: streaming }),
    null,
  );
  // An agent that never asked to stream is unaffected by the capability.
  assert.equal(
    agentStreamingIssue({ stream: false }, { capabilities: buffered }),
    null,
  );
  // A provider record without capabilities is old, not a refusal.
  assert.equal(agentStreamingIssue({ stream: true }, {}), null);
});

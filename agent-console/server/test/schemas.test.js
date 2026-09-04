import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCreateSchema,
  agentRecordSchema,
  agentUpdateSchema,
  invokeSchema,
  mcpServerCreateSchema,
  mcpServerRecordSchema,
  mcpServerUpdateSchema,
  modelProviderCreateSchema,
  modelProviderRecordSchema,
  modelProviderUpdateSchema,
  runtimeResultSchema,
  skillCreateSchema,
  skillRecordSchema,
} from "../src/lib/schemas.js";

const providerId = "507f1f77bcf86cd799439011";
const mcpServerId = "507f1f77bcf86cd799439012";
const skillId = "507f1f77bcf86cd799439013";
const timestamp = "2026-08-06T09:30:00.000Z";

const historicalAgent = {
  name: "reviewer",
  description: "Reviews a repository.",
  systemPrompt: "Review the requested files.",
  modelProviderId: providerId,
  model: "openai/gpt-5",
  tools: ["read_file", "grep"],
  skills: [{ skillId, allowedTools: ["read_file"] }],
  mcpServerIds: [mcpServerId],
  limits: { maxTurns: 12, maxOutputTokens: 8_192 },
  enabled: true,
  isDefault: false,
};

const capabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: true,
};

const openAiCompatibleProvider = {
  name: "nvidia-model",
  provider: "openai-compatible",
  model: "meta/llama-3.3-70b-instruct",
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: "provider-secret",
  auth: { kind: "bearer" },
  capabilities,
  wire: { maxTokensField: "max_tokens" },
  enabled: true,
  isDefault: true,
};

const mcpCapabilities = {
  tools: true,
  resources: true,
  prompts: false,
  elicitation: false,
  connectTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
};

const stdioMcpServer = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
  env: { LOG_LEVEL: "info" },
  auth: { kind: "none" },
  capabilities: mcpCapabilities,
  wire: { stderr: "pipe", cwd: "/workspace" },
  enabled: true,
  autoConnect: true,
};

test("accepts the historical reference-based agent shape and stored record", () => {
  assert.equal(agentCreateSchema.safeParse(historicalAgent).success, true);
  assert.equal(
    agentRecordSchema.safeParse({
      ...historicalAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).success,
    true,
  );
});

test("rejects the removed inline provider shape and malformed references", () => {
  const oldShape = {
    name: "reviewer",
    systemPrompt: "Review files.",
    tools: ["read_file"],
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.6",
    apiKey: "inline-secret",
  };
  assert.equal(agentCreateSchema.safeParse(oldShape).success, false);
  assert.equal(
    agentCreateSchema.safeParse({
      ...historicalAgent,
      modelProviderId: "NOT-AN-OBJECT-ID",
    }).success,
    false,
  );
});

test("rejects duplicate, unavailable, and out-of-scope agent tools", () => {
  assert.equal(
    agentCreateSchema.safeParse({
      ...historicalAgent,
      tools: ["read_file", "read_file"],
    }).success,
    false,
  );
  assert.equal(
    agentCreateSchema.safeParse({
      ...historicalAgent,
      tools: ["read_file", "runtime_tool_that_does_not_exist"],
    }).success,
    false,
  );
  const result = agentCreateSchema.safeParse({
    ...historicalAgent,
    skills: [{ skillId, allowedTools: ["edit_file"] }],
  });
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].path.join("."), "skills.0.allowedTools");
});

test("accepts agent patches and rejects empty updates", () => {
  assert.equal(agentUpdateSchema.safeParse({ enabled: false }).success, true);
  assert.equal(
    agentUpdateSchema.safeParse({ description: null }).success,
    true,
  );
  assert.equal(agentUpdateSchema.safeParse({}).success, false);
});

test("defaults the streaming control off and accepts it on either operation", () => {
  // A historical record has no `stream` key at all and must still parse.
  assert.equal(agentCreateSchema.parse(historicalAgent).stream, false);
  assert.equal(
    agentRecordSchema.parse({
      ...historicalAgent,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).stream,
    false,
  );
  assert.equal(
    agentCreateSchema.parse({ ...historicalAgent, stream: true }).stream,
    true,
  );
  assert.equal(agentUpdateSchema.safeParse({ stream: true }).success, true);
  assert.equal(agentUpdateSchema.safeParse({ stream: "yes" }).success, false);
});

test("accepts historical model provider records and supported secret patches", () => {
  assert.equal(
    modelProviderCreateSchema.safeParse(openAiCompatibleProvider).success,
    true,
  );
  assert.equal(
    modelProviderRecordSchema.safeParse({
      ...openAiCompatibleProvider,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).success,
    true,
  );
  const displayNamedProvider = {
    ...openAiCompatibleProvider,
    name: "NVIDIA Model",
  };
  assert.equal(
    modelProviderCreateSchema.safeParse(displayNamedProvider).success,
    true,
  );
  assert.equal(
    modelProviderRecordSchema.safeParse({
      ...displayNamedProvider,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).success,
    true,
  );
  assert.equal(
    modelProviderUpdateSchema.safeParse({ name: "NVIDIA Model" }).success,
    true,
  );
  assert.equal(
    modelProviderUpdateSchema.safeParse({ name: "unsafe\nname" }).success,
    false,
  );
  for (const patch of [
    { apiKey: "" },
    { apiKey: null },
    { baseURL: "" },
    { baseURL: null },
    { headers: "" },
    { headers: {} },
    { headers: null },
  ]) {
    assert.equal(modelProviderUpdateSchema.safeParse(patch).success, true);
  }
});

test("enforces the deployed model-provider runtime constraints", () => {
  assert.equal(
    modelProviderCreateSchema.safeParse({
      ...openAiCompatibleProvider,
      baseURL: undefined,
    }).success,
    false,
  );
  assert.equal(
    modelProviderCreateSchema.safeParse({
      ...openAiCompatibleProvider,
      headers: { Authorization: "Bearer duplicate" },
    }).success,
    false,
  );
  assert.equal(
    modelProviderCreateSchema.safeParse({
      ...openAiCompatibleProvider,
      provider: "bedrock",
    }).success,
    true,
  );
  for (const baseURL of [
    "https://user:password@models.example.test/v1",
    "https://models.example.test/v1?api_key=secret",
    "https://models.example.test/v1#secret",
    "file:///etc/passwd",
    "ftp://models.example.test/v1",
    "data:text/plain,secret",
  ]) {
    assert.equal(
      modelProviderCreateSchema.safeParse({
        ...openAiCompatibleProvider,
        baseURL,
      }).success,
      false,
    );
  }
});

test("accepts historical stdio and HTTP MCP server shapes", () => {
  assert.equal(mcpServerCreateSchema.safeParse(stdioMcpServer).success, true);
  assert.equal(
    mcpServerRecordSchema.safeParse({
      ...stdioMcpServer,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).success,
    true,
  );
  assert.equal(
    mcpServerCreateSchema.safeParse({
      name: "remote-tools",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      apiKey: "mcp-secret",
      auth: { kind: "header", headerName: "X-MCP-Key" },
      capabilities: mcpCapabilities,
      wire: { sessionId: "stored-session" },
      headers: { "X-Tenant": "tenant-a" },
      enabled: true,
    }).success,
    true,
  );
});

test("enforces transport-specific MCP fields and accepts secret patch forms", () => {
  assert.equal(
    mcpServerCreateSchema.safeParse({
      ...stdioMcpServer,
      url: "https://mcp.example.test/rpc",
    }).success,
    false,
  );
  assert.equal(
    mcpServerCreateSchema.safeParse({
      ...stdioMcpServer,
      headers: { Authorization: "secret" },
    }).success,
    false,
  );
  for (const patch of [
    { apiKey: "" },
    { apiKey: null },
    { env: "" },
    { env: {} },
    { env: null },
    { headers: "" },
    { headers: null },
  ]) {
    assert.equal(mcpServerUpdateSchema.safeParse(patch).success, true);
  }
  for (const url of [
    "https://user:password@mcp.example.test/rpc",
    "https://mcp.example.test/rpc?token=secret",
    "https://mcp.example.test/rpc#secret",
    "file:///etc/passwd",
    "ftp://mcp.example.test/rpc",
    "data:text/plain,secret",
  ]) {
    assert.equal(
      mcpServerCreateSchema.safeParse({
        name: "unsafe-remote",
        transport: "http",
        url,
        apiKey: "mcp-secret",
        auth: { kind: "bearer" },
        capabilities: mcpCapabilities,
      }).success,
      false,
    );
  }
});

test("accepts authored skill content and historical S3 records", () => {
  const authored = {
    name: "sap-documentation",
    content: "# SAP documentation\n\nUse the approved SAP sources.",
    enabled: true,
  };
  assert.equal(skillCreateSchema.safeParse(authored).success, true);
  assert.equal(
    skillCreateSchema.safeParse({
      name: authored.name,
      uri: "s3://agent-console-skills/sap/SKILL.md",
      enabled: true,
    }).success,
    false,
  );
  assert.equal(
    skillRecordSchema.safeParse({
      name: authored.name,
      uri: "s3://agent-console-skills/sap/SKILL.md",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: "agent-console",
    }).success,
    true,
  );
});

test("uses the intersection of AgentCore and harness session id limits", () => {
  assert.equal(
    invokeSchema.safeParse({
      prompt: "hello",
      runtimeSessionId: "a".repeat(200),
    }).success,
    true,
  );
  assert.equal(
    invokeSchema.safeParse({
      prompt: "hello",
      runtimeSessionId: "a".repeat(201),
    }).success,
    false,
  );
});

test("rejects malformed runtime results before persistence", () => {
  assert.equal(
    runtimeResultSchema.safeParse({ status: "success", output: "partial" })
      .success,
    false,
  );
  assert.equal(
    runtimeResultSchema.safeParse({
      status: "success",
      sessionId: "session",
      agentName: "reviewer",
      session: {
        mode: "persistent",
        resumed: false,
        origin: "new",
        historyMessageCount: 2,
      },
      output: "done",
      messages: [],
      workingDirectory: "/tmp/work",
      turns: 1,
      usage: { inputTokens: 4, outputTokens: 2 },
      tools: [],
      durationMs: 10,
    }).success,
    true,
  );
});

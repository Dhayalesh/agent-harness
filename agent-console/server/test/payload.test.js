import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/models/agent.js";
import { ModelProvider } from "../src/models/model-provider.js";
import { Skill } from "../src/models/skill.js";
import { buildPayload, redactPayload } from "../src/services/payload.js";
import { config } from "../src/config.js";
import { skillDecisionBackend } from "../src/services/skill-routing.js";

const timestamp = "2026-08-10T09:30:00.000Z";

test("builds URI-only skill descriptors without loading S3 content", async (context) => {
  const agentId = "507f1f77bcf86cd799439011";
  const providerId = "507f1f77bcf86cd799439012";
  const reviewSkillId = "507f1f77bcf86cd799439013";
  const codingSkillId = "507f1f77bcf86cd799439014";
  const agent = new Agent({
    _id: agentId,
    name: "reviewer",
    systemPrompt: "Review the requested change.",
    modelProviderId: providerId,
    tools: ["read_file", "edit_file"],
    skills: [
      { skillId: reviewSkillId, allowedTools: ["read_file"] },
      { skillId: codingSkillId },
    ],
    mcpServerIds: [],
    limits: { maxTurns: 12, maxOutputTokens: 2_000 },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });
  const provider = new ModelProvider({
    _id: providerId,
    name: "Test Provider",
    provider: "openai-compatible",
    model: "test-model",
    baseURL: "https://models.example.test/v1",
    apiKey: "provider-secret",
    auth: { kind: "bearer" },
    capabilities: {
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      supportsTools: true,
      supportsStreaming: true,
      supportsReasoning: false,
    },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });
  const skills = new Map([
    [
      reviewSkillId,
      new Skill({
        _id: reviewSkillId,
        name: "review_rules",
        uri: "s3://agent-skills/review/SKILL.md",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: "agent-console",
      }),
    ],
    [
      codingSkillId,
      new Skill({
        _id: codingSkillId,
        name: "coding_rules",
        uri: "s3://agent-skills/coding/SKILL.md",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: "agent-console",
      }),
    ],
  ]);

  context.mock.method(Agent, "findById", async (id) => {
    assert.equal(id, agentId);
    return agent;
  });
  context.mock.method(ModelProvider, "findById", (id) => {
    assert.equal(id, providerId);
    return selectableQuery(provider);
  });
  context.mock.method(Skill, "findById", async (id) => skills.get(id));

  const { payload, resolved } = await buildPayload({
    agentId,
    prompt: "Review this patch.",
    sessionId: "a".repeat(36),
    sessionHistory: [
      {
        id: "message-1",
        role: "user",
        content: "Earlier question",
        createdAt: timestamp,
      },
    ],
  });

  assert.deepEqual(payload.session, {
    mode: "persistent",
    history: [
      {
        id: "message-1",
        role: "user",
        content: "Earlier question",
        createdAt: timestamp,
      },
    ],
  });
  assert.equal("operation" in payload, false);

  const { payload: compactPayload } = await buildPayload({
    agentId,
    prompt: "",
    sessionId: "a".repeat(36),
    operation: "compact",
  });
  assert.equal(compactPayload.operation, "compact");
  assert.equal(compactPayload.prompt, "");
  assert.equal(compactPayload.sessionId, payload.sessionId);

  assert.deepEqual(payload.skills, [
    {
      name: "review_rules",
      uri: "s3://agent-skills/review/SKILL.md",
      allowedTools: ["read_file"],
    },
    {
      name: "coding_rules",
      uri: "s3://agent-skills/coding/SKILL.md",
    },
  ]);
  assert.equal(
    payload.skills.some((skill) => "document" in skill),
    false,
  );
  assert.equal(
    resolved.skills.some((skill) => "documentBody" in skill),
    false,
  );
  assert.deepEqual(payload.agent.tools, ["read_file", "edit_file"]);
  assert.deepEqual(payload.permissionRules, [
    { tool: "read_file", decision: "allow" },
    { tool: "edit_file", decision: "allow" },
    { tool: "skill", decision: "allow" },
  ]);
  assert.equal(payload.permissionFallback, "deny");
  assert.equal(
    payload.permissionRules.some((rule) => rule.tool === "web_search"),
    false,
  );

  const originalRouting = config.skillRouting;
  context.after(() => { config.skillRouting = originalRouting; });
  config.skillRouting = { mode: "laya", threshold: 0.75, maxSelections: 5, fallback: "error" };
  for (const skill of skills.values()) skill.routingDescription = "Review source code";
  context.mock.method(skillDecisionBackend, "score", async ({ options }) => options.map(({ id }) => ({
    id, score: id === reviewSkillId ? 0.99 : 0.1,
  })));
  const routed = await buildPayload({ agentId, prompt: "Review this patch" });
  assert.deepEqual(routed.payload.skills, [payload.skills[0]]);
  assert.equal(routed.resolved.skillRouting.status, "selected");
  assert.equal("routingDescription" in routed.payload.skills[0], false);
  assert.deepEqual(routed.payload.agent.tools, payload.agent.tools);
  const compact = await buildPayload({ agentId, prompt: "", operation: "compact" });
  assert.deepEqual(compact.payload.skills, []);
  assert.equal(compact.resolved.skillRouting.status, "skipped");
  skills.get(reviewSkillId).enabled = false;
  const noMatch = await buildPayload({ agentId, prompt: "Hello" });
  assert.deepEqual(noMatch.payload.skills, []);
  assert.equal(noMatch.payload.permissionRules.some((rule) => rule.tool === "skill"), false);
});

test("recursively redacts credentials, headers, and environment values", () => {
  const payload = {
    modelProvider: {
      apiKey: "provider-secret",
      auth: {
        accessToken: "access-token",
        refresh_token: "refresh-token",
      },
      headers: {
        Authorization: "Bearer provider-secret",
        "X-OpenRouter-Title": "Agent Console",
      },
    },
    mcpServers: [
      {
        api_key: "mcp-secret",
        env: {
          DATABASE_URL: "mongodb://user:password@example.test/db",
          PUBLIC_MODE: "production",
        },
        nested: {
          password: "nested-password",
          clientSecret: "nested-secret",
          tokenCount: 7,
        },
      },
    ],
    harmless: {
      monkey: "visible",
      tokenCount: 3,
    },
  };

  const redacted = redactPayload(payload);

  assert.equal(redacted.modelProvider.apiKey, "***redacted***");
  assert.equal(redacted.modelProvider.auth.accessToken, "***redacted***");
  assert.equal(redacted.modelProvider.auth.refresh_token, "***redacted***");
  assert.deepEqual(redacted.modelProvider.headers, {
    Authorization: "***redacted***",
    "X-OpenRouter-Title": "***redacted***",
  });
  assert.equal(redacted.mcpServers[0].api_key, "***redacted***");
  assert.deepEqual(redacted.mcpServers[0].env, {
    DATABASE_URL: "***redacted***",
    PUBLIC_MODE: "***redacted***",
  });
  assert.equal(redacted.mcpServers[0].nested.password, "***redacted***");
  assert.equal(redacted.mcpServers[0].nested.clientSecret, "***redacted***");
  assert.equal(redacted.mcpServers[0].nested.tokenCount, 7);
  assert.deepEqual(redacted.harmless, { monkey: "visible", tokenCount: 3 });

  assert.equal(payload.modelProvider.apiKey, "provider-secret");
  assert.equal(payload.mcpServers[0].env.PUBLIC_MODE, "production");
});

test("preserves absent credentials while redacting populated values in arrays", () => {
  assert.deepEqual(
    redactPayload([
      { apiKey: "", secret: null, password: undefined },
      { token: "set", value: "visible" },
    ]),
    [
      { apiKey: "", secret: null, password: undefined },
      { token: "***redacted***", value: "visible" },
    ],
  );
});

function selectableQuery(value) {
  return {
    select() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

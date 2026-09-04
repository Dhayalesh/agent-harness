/**
 * The context meter's server half.
 *
 * Three seams, each tested where it can break independently: the event fold that
 * turns `context.usage` frames into a stored shape, the payload flag that asks the
 * runtime to compact, and the provider summary that gives the client a window to
 * measure against.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../src/models/agent.js";
import { ModelProvider } from "../src/models/model-provider.js";
import { McpServer } from "../src/models/mcp-server.js";
import { Skill } from "../src/models/skill.js";
import { buildPayload } from "../src/services/payload.js";
import { resolveAgentSummaries } from "../src/services/platform.js";
import { RunTotals } from "../src/services/run-totals.js";
import { runtimeResultSchema } from "../src/lib/schemas.js";

const timestamp = "2026-08-19T09:30:00.000Z";

/**
 * `loadModelProvider` calls `.select()` for its side effect and awaits the query
 * itself, so the stand-in has to be a thenable that returns itself from `select`.
 * Mirrors the helper in `payload.test.js`.
 */
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

function fixtures({ contextWindow = 256_000, maxOutputTokens = 16_000 } = {}) {
  const agentId = "507f1f77bcf86cd799439021";
  const providerId = "507f1f77bcf86cd799439022";
  const agent = new Agent({
    _id: agentId,
    name: "context-agent",
    systemPrompt: "Answer the question.",
    modelProviderId: providerId,
    tools: ["read_file"],
    skills: [],
    mcpServerIds: [],
    limits: { maxTurns: 8 },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });
  const provider = new ModelProvider({
    _id: providerId,
    name: "Context Provider",
    provider: "openai-compatible",
    model: "test-model",
    baseURL: "https://models.example.test/v1",
    apiKey: "provider-secret",
    auth: { kind: "bearer" },
    capabilities: {
      contextWindow,
      maxOutputTokens,
      supportsTools: true,
      supportsStreaming: true,
      supportsReasoning: false,
    },
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: "agent-console",
  });
  return { agentId, providerId, agent, provider };
}

// ---------------------------------------------------------------------------
// RunTotals
// ---------------------------------------------------------------------------

test("run totals keeps the newest context measurement and counts compactions", () => {
  const totals = new RunTotals();
  for (const event of [
    { type: "session.started", sessionId: "s1" },
    {
      type: "context.usage",
      usedTokens: 100_000,
      budgetTokens: 238_000,
      contextWindow: 256_000,
      reservedOutputTokens: 16_000,
      usedPercent: 42,
      compacted: false,
    },
    { type: "context.compaction.started", estimatedTokens: 230_000 },
    {
      type: "context.compaction.completed",
      tokensBefore: 230_000,
      tokensAfter: 60_000,
    },
    {
      type: "context.usage",
      usedTokens: 60_000,
      budgetTokens: 238_000,
      contextWindow: 256_000,
      reservedOutputTokens: 16_000,
      usedPercent: 25.2,
      compacted: true,
    },
    { type: "session.completed", reason: "end_turn" },
  ]) {
    totals.observe(event);
  }

  const result = totals.result({
    agentName: "context-agent",
    durationMs: 1_200,
    runtimeSessionId: "s1",
  });

  // The later measurement wins, so the meter shows the post-compaction figure.
  assert.equal(result.context.usedTokens, 60_000);
  assert.equal(result.context.usedPercent, 25.2);
  assert.equal(result.context.budgetTokens, 238_000);
  assert.equal(result.context.contextWindow, 256_000);
  assert.equal(result.context.reservedOutputTokens, 16_000);
  assert.equal(result.context.compacted, true);
  assert.equal(result.context.compactions, 1);
});

test("a run that reported no context usage stores none", () => {
  const totals = new RunTotals();
  totals.observe({ type: "session.started", sessionId: "s2" });
  totals.observe({ type: "assistant.text.delta", delta: "hello" });
  totals.observe({ type: "session.completed", reason: "end_turn" });

  const result = totals.result({
    agentName: "context-agent",
    durationMs: 40,
    runtimeSessionId: "s2",
  });

  // Absent rather than zeroed: "no context layer" must stay distinguishable from
  // "an empty context", because the second would render a real 0% meter.
  assert.equal(result.context, undefined);
});

test("the runtime result schema accepts a context block and tolerates its absence", () => {
  const base = {
    status: "success",
    sessionId: "s3",
    agentName: "context-agent",
    session: {
      mode: "persistent",
      resumed: false,
      origin: "new",
      historyMessageCount: 2,
    },
    output: "done",
    messages: [],
    workingDirectory: "/tmp/run",
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 4 },
    tools: [],
    durationMs: 90,
  };

  assert.equal(runtimeResultSchema.safeParse(base).success, true);

  const withContext = runtimeResultSchema.safeParse({
    ...base,
    context: {
      usedTokens: 1_000,
      budgetTokens: 238_000,
      contextWindow: 256_000,
      reservedOutputTokens: 16_000,
      usedPercent: 0.4,
      compacted: false,
      compactions: 0,
    },
  });
  assert.equal(withContext.success, true);
  assert.equal(withContext.data.context.budgetTokens, 238_000);
});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

test("compactContext is sent only when asked for", async (context) => {
  const { agentId, providerId, agent, provider } = fixtures();
  context.mock.method(Agent, "findById", async () => agent);
  context.mock.method(ModelProvider, "findById", (id) => {
    assert.equal(id, providerId);
    return selectableQuery(provider);
  });

  const quiet = await buildPayload({
    agentId,
    prompt: "hello",
    sessionId: "a".repeat(36),
  });
  // Omitted, not false: the runtime payload schema is strict, so a console talking
  // to a runtime built before this field existed must not send it unprompted.
  assert.equal("compactContext" in quiet.payload, false);

  const asked = await buildPayload({
    agentId,
    prompt: "hello",
    sessionId: "a".repeat(36),
    compactContext: true,
  });
  assert.equal(asked.payload.compactContext, true);
});

test("the payload carries the provider capabilities the context budget derives from", async (context) => {
  const { agentId, agent, provider } = fixtures({
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
  });
  context.mock.method(Agent, "findById", async () => agent);
  context.mock.method(ModelProvider, "findById", () => selectableQuery(provider));

  const { payload } = await buildPayload({
    agentId,
    prompt: "hello",
    sessionId: "a".repeat(36),
  });

  assert.equal(payload.modelProvider.capabilities.contextWindow, 1_000_000);
  assert.equal(payload.modelProvider.capabilities.maxOutputTokens, 32_000);
});

// ---------------------------------------------------------------------------
// Agent summary
// ---------------------------------------------------------------------------

test("the resolved agent summary exposes the window without the credential", async (context) => {
  const { agent, provider } = fixtures({
    contextWindow: 400_000,
    maxOutputTokens: 8_192,
  });
  context.mock.method(ModelProvider, "find", () => selectableQuery([provider]));
  context.mock.method(McpServer, "find", () => selectableQuery([]));
  context.mock.method(Skill, "find", async () => []);

  const [summary] = await resolveAgentSummaries([agent]);
  const resolvedProvider = summary.resolved.modelProvider;

  assert.deepEqual(resolvedProvider.capabilities, {
    contextWindow: 400_000,
    maxOutputTokens: 8_192,
  });
  // The meter needs the window; it must never need the key to get it.
  assert.equal("apiKey" in resolvedProvider, false);
  assert.equal(resolvedProvider.hasApiKey, true);
});

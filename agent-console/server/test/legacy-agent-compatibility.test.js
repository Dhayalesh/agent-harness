import assert from "node:assert/strict";
import test from "node:test";
import { agentRecordSchema } from "../src/lib/schemas.js";

const providerId = "64f0c5e4a8c7b3d9e1f2a345";

test("a stored agent with retired Context Intelligence config remains invokable", () => {
  const parsed = agentRecordSchema.parse({
    name: "legacy-agent",
    systemPrompt: "Help the user.",
    modelProviderId: providerId,
    tools: ["read_file"],
    skills: [],
    templates: [],
    mcpServerIds: [],
    limits: { maxTurns: 24 },
    stream: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    createdBy: "agent-console",
    contextIntelligence: {
      enabled: true,
      budgets: { maxRetrievalIterations: 3 },
    },
  });

  assert.equal(parsed.name, "legacy-agent");
  assert.equal(Object.hasOwn(parsed, "contextIntelligence"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  modelProviderCreateSchema,
  modelProviderRecordSchema,
} from "../src/lib/schemas.js";

const provider = {
  name: "glm-provider",
  provider: "openai-compatible",
  model: "zai.glm-5",
  baseURL: "https://bedrock-mantle.us-east-1.api.aws/v1",
  apiKey: "provider-secret",
  auth: { kind: "bearer" },
  capabilities: {
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsReasoning: false,
  },
  enabled: true,
};

const provenance = {
  createdAt: "2026-08-19T17:32:04.131Z",
  updatedAt: "2026-09-04T08:51:28.303Z",
  createdBy: "agent-console",
};

/**
 * The deployed harness validates `modelProvider.capabilities` strictly and
 * requires `reportsCost`. A payload built without it is refused with HTTP 400
 * before the run starts, so the field has to survive parsing rather than be
 * stripped as a retired one.
 */
test("a stored capabilities.reportsCost survives to the harness payload", () => {
  const parsed = modelProviderRecordSchema.parse({
    ...provider,
    capabilities: { ...provider.capabilities, reportsCost: true },
    ...provenance,
  });

  assert.equal(parsed.capabilities.reportsCost, true);
});

test("capabilities without reportsCost still resolve to a boolean for the harness", () => {
  // The provider form does not expose the flag, so a create omits it.
  const created = modelProviderCreateSchema.parse(provider);
  assert.equal(created.capabilities.reportsCost, false);

  const parsed = modelProviderRecordSchema.parse({ ...provider, ...provenance });
  assert.equal(parsed.capabilities.reportsCost, false);
});

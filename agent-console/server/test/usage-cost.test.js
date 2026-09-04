import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUsageCost,
  calculateUsageCost,
} from "../src/services/usage-cost.js";

const pricing = {
  model: "vendor/model",
  currency: "USD",
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  cacheReadPerMillionTokens: 0.3,
  cacheWritePerMillionTokens: 3.75,
  reasoningPerMillionTokens: 15,
  requestUsd: 0.001,
  source: "provider-catalog",
  sourceLabel: "Provider model catalogue",
  sourceUrl: "https://models.example.test/v1/models",
  fetchedAt: "2026-09-04T00:00:00.000Z",
};

test("calculates cache and reasoning as priced subsets rather than extra tokens", () => {
  assert.deepEqual(
    calculateUsageCost(
      {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 400,
        reasoningTokens: 100,
      },
      pricing,
    ),
    {
      totalUsd: 0.00592,
      inputUsd: 0.0018,
      outputUsd: 0.0015,
      cacheReadUsd: 0.00012,
      cacheWriteUsd: 0,
      reasoningUsd: 0.0015,
      requestUsd: 0.001,
    },
  );
});

test("provider-reported totals remain authoritative while the rate snapshot is retained", () => {
  const result = {
    usage: { inputTokens: 1_000, outputTokens: 200, estimatedCostUsd: 0.02 },
    usageDetails: [
      {
        turnId: "turn-1",
        usage: { inputTokens: 1_000, outputTokens: 200 },
        toolCallIds: [],
      },
    ],
    turns: 1,
  };
  applyUsageCost(result, {
    pricing,
    modelProviderId: "provider-id",
    modelProviderName: "Primary",
    provider: "openrouter",
    model: "vendor/model",
    calculatedAt: "2026-09-04T01:00:00.000Z",
  });

  assert.equal(result.usage.estimatedCostUsd, 0.02);
  assert.equal(result.usageDetails[0].usage.estimatedCostUsd, 0.007);
  assert.equal(result.cost.totalUsd, 0.02);
  assert.equal(result.cost.source, "provider-reported");
  assert.equal(result.cost.estimated, false);
  assert.deepEqual(result.cost.pricing, pricing);
});

test("never applies a rate card belonging to a different model", () => {
  const result = { usage: { inputTokens: 10, outputTokens: 2 }, turns: 1 };
  applyUsageCost(result, {
    pricing,
    provider: "openrouter",
    model: "vendor/override",
  });
  assert.equal(result.cost, undefined);
  assert.equal(result.usage.estimatedCostUsd, undefined);
});


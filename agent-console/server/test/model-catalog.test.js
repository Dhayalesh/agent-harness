import assert from "node:assert/strict";
import test from "node:test";
import { discoverProviderModels } from "../src/services/model-catalog.js";

const NOW = new Date("2026-09-04T02:00:00.000Z");

function catalogueFetch(data) {
  return async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

test("normalizes OpenRouter capabilities from the provider catalogue", async () => {
  const result = await discoverProviderModels({
    provider: "openrouter",
    apiKey: "secret",
    fetchImplementation: catalogueFetch([
      {
        id: "anthropic/claude-test",
        name: "Claude Test",
        context_length: 200_000,
        top_provider: { max_completion_tokens: 8_192 },
        supported_parameters: ["tools", "reasoning"],
        architecture: { input_modalities: ["text", "image"] },
      },
    ]),
    now: () => NOW,
  });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].contextWindow, 200_000);
  assert.equal(result.models[0].maxOutputTokens, 8_192);
  assert.equal(result.models[0].supportsTools, true);
  assert.equal(result.models[0].supportsReasoning, true);
  assert.deepEqual(result.models[0].inputModalities, ["text", "image"]);
});

test("falls back to the model id when a display name is absent", async () => {
  const result = await discoverProviderModels({
    provider: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    apiKey: "secret",
    fetchImplementation: catalogueFetch([{ id: "vendor/model" }]),
    now: () => NOW,
  });

  assert.equal(result.models[0].id, "vendor/model");
  assert.equal(result.models[0].name, "vendor/model");
});

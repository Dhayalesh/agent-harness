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

test("normalizes OpenRouter capabilities and per-token prices into per-million USD", async () => {
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
        pricing: {
          prompt: "0.000003",
          completion: "0.000015",
          input_cache_read: "0.0000003",
        },
      },
    ]),
    priceCatalog: null,
    now: () => NOW,
  });

  assert.equal(result.models.length, 1);
  assert.equal(result.pricedModels, 1);
  assert.deepEqual(result.models[0].pricing, {
    model: "anthropic/claude-test",
    currency: "USD",
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
    cacheReadPerMillionTokens: 0.3,
    source: "provider-catalog",
    sourceLabel: "Provider model catalogue",
    sourceUrl: "https://openrouter.ai/api/v1/models",
    fetchedAt: NOW.toISOString(),
  });
  assert.equal(result.models[0].contextWindow, 200_000);
  assert.equal(result.models[0].maxOutputTokens, 8_192);
  assert.equal(result.models[0].supportsTools, true);
});

test("joins Bedrock model availability to a labelled price-catalog entry", async () => {
  const result = await discoverProviderModels({
    provider: "bedrock",
    baseURL: "https://bedrock-mantle.us-east-1.api.aws/v1",
    apiKey: "bedrock-key",
    fetchImplementation: catalogueFetch([
      { id: "openai.gpt-oss-120b", name: "GPT OSS 120B" },
    ]),
    priceCatalog: {
      "bedrock_mantle/openai.gpt-oss-120b": {
        litellm_provider: "bedrock_mantle",
        mode: "chat",
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006,
        max_input_tokens: 131_072,
        max_output_tokens: 65_536,
        supports_function_calling: true,
        source: "https://aws.amazon.com/bedrock/pricing/",
      },
    },
    now: () => NOW,
  });

  const model = result.models[0];
  assert.equal(model.pricing.inputPerMillionTokens, 0.15);
  assert.equal(model.pricing.outputPerMillionTokens, 0.6);
  assert.equal(model.pricing.source, "litellm-catalog");
  assert.equal(model.contextWindow, 131_072);
  assert.equal(model.maxOutputTokens, 65_536);
  assert.equal(model.supportsTools, true);
});

test("marks only NVIDIA's hosted developer endpoint as zero-cost prototyping", async () => {
  const result = await discoverProviderModels({
    provider: "nvidia",
    apiKey: "nvidia-key",
    fetchImplementation: catalogueFetch([
      { id: "nvidia/test-model", name: "Test Model" },
    ]),
    priceCatalog: null,
    now: () => NOW,
  });

  assert.equal(result.models[0].pricing.inputPerMillionTokens, 0);
  assert.equal(result.models[0].pricing.outputPerMillionTokens, 0);
  assert.equal(result.models[0].pricing.source, "nvidia-hosted-free");
});

test("does not guess the units of generic input/output price fields", async () => {
  const result = await discoverProviderModels({
    provider: "openai-compatible",
    baseURL: "https://models.example.test/v1",
    apiKey: "secret",
    fetchImplementation: catalogueFetch([
      {
        id: "vendor/model",
        pricing: { input: 3, output: 15 },
      },
    ]),
    priceCatalog: null,
    now: () => NOW,
  });

  assert.equal(result.models[0].pricing, undefined);
  assert.equal(result.pricedModels, 0);
});

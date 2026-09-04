import { badGateway } from "../lib/http-error.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const LITELLM_PRICE_CATALOG_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const NVIDIA_PRICING_URL = "https://docs.api.nvidia.com/nim/docs/run-anywhere";
const MAX_CATALOG_BYTES = 24 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

let priceCatalogCache;

/**
 * Fetches the provider's routable model list and attaches a normalized rate card.
 * Provider data always wins; LiteLLM is only a labelled fallback for catalogues
 * (notably Bedrock) whose `/models` response intentionally omits pricing.
 */
export async function discoverProviderModels({
  provider,
  baseURL,
  apiKey,
  fetchImplementation = globalThis.fetch,
  now = () => new Date(),
  priceCatalog,
}) {
  const endpoint = catalogBaseUrl(provider, baseURL);
  const payload = await fetchJson(`${endpoint}/models`, {
    apiKey,
    fetchImplementation,
    label: provider,
  });
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : null;
  if (!entries) {
    throw badGateway(`${provider} returned a malformed model catalogue.`);
  }

  const fetchedAt = now().toISOString();
  const direct = entries.flatMap((entry) => {
    const model = normalizeProviderModel(entry, { provider, endpoint, fetchedAt });
    return model ? [model] : [];
  });

  let fallback = priceCatalog;
  if (
    fallback === undefined &&
    direct.some((model) => model.pricing === undefined) &&
    provider !== "openrouter"
  ) {
    try {
      fallback = await loadPriceCatalog({ fetchImplementation, now });
    } catch {
      // Availability is still useful when the secondary price source is down.
      fallback = null;
    }
  }

  const models = direct
    .map((model) =>
      enrichModel(model, {
        provider,
        endpoint,
        fetchedAt,
        priceCatalog: fallback,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    provider,
    baseURL: endpoint,
    fetchedAt,
    models,
    pricedModels: models.filter((model) => model.pricing).length,
  };
}

export function normalizeProviderModel(value, { provider, endpoint, fetchedAt }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = stringValue(value.id ?? value.modelId ?? value.name);
  if (!id) return null;
  const topProvider = record(value.top_provider);
  const architecture = record(value.architecture);
  const supported = Array.isArray(value.supported_parameters)
    ? value.supported_parameters
    : [];
  const pricing = directPricing(value.pricing ?? value, {
    provider,
    model: id,
    endpoint,
    fetchedAt,
  });
  const contextWindow = positiveNumber(
    value.context_length ??
      value.contextWindow ??
      topProvider?.context_length ??
      value.max_input_tokens,
  );
  const maxOutputTokens = positiveNumber(
    topProvider?.max_completion_tokens ??
      value.max_completion_tokens ??
      value.max_output_tokens,
  );

  return compact({
    id,
    name: stringValue(value.name ?? value.display_name) ?? id,
    contextWindow,
    maxOutputTokens,
    supportsTools:
      booleanValue(value.supports_function_calling) ??
      (supported.length ? supported.includes("tools") : undefined),
    supportsStreaming: booleanValue(value.supports_streaming) ?? true,
    supportsReasoning:
      booleanValue(value.supports_reasoning) ??
      (value.reasoning === undefined
        ? supported.includes("reasoning")
        : Boolean(value.reasoning)),
    inputModalities: Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities.filter((entry) => typeof entry === "string")
      : undefined,
    pricing,
    provider,
  });
}

function enrichModel(model, { provider, endpoint, fetchedAt, priceCatalog }) {
  if (model.pricing) return model;

  const catalogMatch = findPriceCatalogEntry(priceCatalog, {
    provider,
    endpoint,
    model: model.id,
  });
  if (catalogMatch) {
    const { value, key } = catalogMatch;
    const pricing = liteLlmPricing(value, {
      model: model.id,
      fetchedAt,
      key,
    });
    return compact({
      ...model,
      contextWindow:
        model.contextWindow ??
        positiveNumber(value.max_input_tokens ?? value.max_tokens),
      maxOutputTokens:
        model.maxOutputTokens ?? positiveNumber(value.max_output_tokens),
      supportsTools:
        model.supportsTools ?? booleanValue(value.supports_function_calling),
      supportsReasoning:
        model.supportsReasoning ?? booleanValue(value.supports_reasoning),
      pricing,
    });
  }

  // NVIDIA's public hosted API is a free prototyping service, not a metered
  // production API. Self-hosted/enterprise NIM has infrastructure or contract
  // pricing and therefore deliberately remains unpriced here.
  if (provider === "nvidia" && new URL(endpoint).hostname === "integrate.api.nvidia.com") {
    return {
      ...model,
      pricing: {
        model: model.id,
        currency: "USD",
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
        source: "nvidia-hosted-free",
        sourceLabel: "NVIDIA hosted developer API (free prototyping)",
        sourceUrl: NVIDIA_PRICING_URL,
        fetchedAt,
      },
    };
  }
  return model;
}

function directPricing(value, { provider, model, endpoint, fetchedAt }) {
  const pricing = record(value);
  if (!pricing) return undefined;
  // OpenRouter documents `prompt` and `completion` as USD/token. For an
  // arbitrary OpenAI-compatible catalogue only accept field names that state
  // the unit; guessing whether `input: 3` means per-token or per-million can
  // create a million-fold accounting error.
  const input = pricePerToken(
    provider === "openrouter"
      ? pricing.prompt
      : pricing.input_cost_per_token,
  );
  const output = pricePerToken(
    provider === "openrouter"
      ? pricing.completion
      : pricing.output_cost_per_token,
  );
  if (input === undefined || output === undefined) return undefined;

  return compact({
    model,
    currency: "USD",
    inputPerMillionTokens: input * 1_000_000,
    outputPerMillionTokens: output * 1_000_000,
    cacheReadPerMillionTokens:
      pricePerToken(
        provider === "openrouter"
          ? pricing.input_cache_read
          : pricing.cache_read_input_token_cost,
      ) * 1_000_000,
    cacheWritePerMillionTokens:
      pricePerToken(
        provider === "openrouter"
          ? pricing.input_cache_write
          : pricing.cache_creation_input_token_cost,
      ) * 1_000_000,
    reasoningPerMillionTokens:
      pricePerToken(
        provider === "openrouter"
          ? pricing.internal_reasoning
          : pricing.output_cost_per_reasoning_token,
      ) * 1_000_000,
    requestUsd: finiteNumber(
      provider === "openrouter" ? pricing.request : pricing.cost_per_request,
    ),
    source: "provider-catalog",
    sourceLabel: "Provider model catalogue",
    sourceUrl: pricingSourceUrl(pricing) ?? `${endpoint}/models`,
    fetchedAt,
  });
}

function liteLlmPricing(value, { model, fetchedAt, key }) {
  const input = finiteNumber(value.input_cost_per_token);
  const output = finiteNumber(value.output_cost_per_token);
  if (input === undefined || output === undefined) return undefined;
  return compact({
    model,
    currency: "USD",
    inputPerMillionTokens: input * 1_000_000,
    outputPerMillionTokens: output * 1_000_000,
    cacheReadPerMillionTokens:
      finiteNumber(value.cache_read_input_token_cost) * 1_000_000,
    cacheWritePerMillionTokens:
      finiteNumber(value.cache_creation_input_token_cost) * 1_000_000,
    reasoningPerMillionTokens:
      finiteNumber(value.output_cost_per_reasoning_token) * 1_000_000,
    requestUsd: finiteNumber(value.cost_per_request),
    source: "litellm-catalog",
    sourceLabel: `LiteLLM price catalogue (${key})`.slice(0, 200),
    sourceUrl: pricingSourceUrl(value) ?? LITELLM_PRICE_CATALOG_URL,
    fetchedAt,
  });
}

export function findPriceCatalogEntry(catalog, { provider, endpoint, model }) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return null;
  const preferredProviders = priceProviders(provider, endpoint);
  const candidates = [];
  for (const [key, raw] of Object.entries(catalog)) {
    const value = record(raw);
    if (!value || !["chat", "completion", "responses"].includes(value.mode)) continue;
    if (!preferredProviders.includes(value.litellm_provider)) continue;
    if (!modelKeys(key, value.litellm_provider).includes(model)) continue;
    candidates.push({ key, value });
  }
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) return null;

  // Prefer the exact Bedrock endpoint family when both native and Mantle rows
  // exist for the same model. Otherwise only accept identical rates.
  const hostname = new URL(endpoint).hostname;
  const desired = hostname.includes("bedrock-mantle")
    ? "bedrock_mantle"
    : hostname.includes("bedrock-runtime")
      ? "bedrock"
      : undefined;
  const exact = candidates.find(
    ({ value }) => desired && value.litellm_provider === desired,
  );
  if (exact) return exact;
  const signatures = new Set(
    candidates.map(({ value }) =>
      JSON.stringify([
        value.input_cost_per_token,
        value.output_cost_per_token,
        value.cache_read_input_token_cost,
        value.cache_creation_input_token_cost,
      ]),
    ),
  );
  return signatures.size === 1 ? candidates[0] : null;
}

async function loadPriceCatalog({ fetchImplementation, now }) {
  const current = now().getTime();
  if (priceCatalogCache && current - priceCatalogCache.loadedAt < CACHE_TTL_MS) {
    return priceCatalogCache.value;
  }
  const value = await fetchJson(LITELLM_PRICE_CATALOG_URL, {
    fetchImplementation,
    label: "pricing",
  });
  priceCatalogCache = { value, loadedAt: current };
  return value;
}

async function fetchJson(url, { apiKey, fetchImplementation, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const text = await response.text();
    if (text.length > MAX_CATALOG_BYTES) {
      throw badGateway(`${label} model catalogue is too large.`);
    }
    if (!response.ok) {
      throw badGateway(
        `${label} model catalogue failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw badGateway(`${label} returned invalid catalogue JSON.`);
    }
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") {
      throw badGateway(`${label} model catalogue timed out.`);
    }
    throw badGateway(`${label} model catalogue could not be reached: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function catalogBaseUrl(provider, baseURL) {
  const value =
    stringValue(baseURL) ??
    (provider === "openrouter"
      ? OPENROUTER_BASE_URL
      : provider === "nvidia"
        ? NVIDIA_BASE_URL
        : null);
  if (!value) throw badGateway(`${provider} requires a model catalogue base URL.`);
  return value.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

function priceProviders(provider, endpoint) {
  if (provider === "bedrock") return ["bedrock_mantle", "bedrock", "bedrock_converse"];
  if (provider === "nvidia") return ["nvidia_nim"];
  if (provider === "openrouter") return ["openrouter"];
  const hostname = new URL(endpoint).hostname;
  const known = [
    [/api\.openai\.com$/, "openai"],
    [/api\.groq\.com$/, "groq"],
    [/api\.deepinfra\.com$/, "deepinfra"],
    [/api\.together\.xyz$/, "together_ai"],
    [/api\.fireworks\.ai$/, "fireworks_ai"],
  ].find(([pattern]) => pattern.test(hostname));
  return known ? [known[1]] : [];
}

function modelKeys(key, provider) {
  const keys = new Set([key]);
  if (key.startsWith(provider + "/")) keys.add(key.slice(provider.length + 1));
  if (provider === "nvidia_nim" && key.startsWith("nvidia_nim/")) {
    keys.add(key.slice("nvidia_nim/".length));
  }
  return [...keys];
}

function pricingSourceUrl(pricing) {
  const source = stringValue(pricing.source);
  if (!source) return undefined;
  try {
    const url = new URL(source);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function pricePerToken(value) {
  return finiteNumber(value);
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveNumber(value) {
  const parsed = finiteNumber(value);
  return parsed > 0 ? parsed : undefined;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && !Number.isNaN(entry),
    ),
  );
}

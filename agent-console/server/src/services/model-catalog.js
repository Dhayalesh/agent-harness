import { badGateway } from "../lib/http-error.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

const MAX_CATALOG_BYTES = 24 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 15_000;

/**
 * Fetches the provider's routable model list and normalizes its capabilities.
 */
export async function discoverProviderModels({
  provider,
  baseURL,
  apiKey,
  fetchImplementation = globalThis.fetch,
  now = () => new Date(),
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
  const models = entries
    .flatMap((entry) => {
      const model = normalizeProviderModel(entry, { provider, endpoint, fetchedAt });
      return model ? [model] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    provider,
    baseURL: endpoint,
    fetchedAt,
    models,
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
    provider,
  });
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

import { AgentHarnessError } from '../core/errors.js';
import { OpenAICompatibleModelProvider } from './openai-compatible-provider.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from './provider.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Default routing slug. Every model id used by the harness is an OpenRouter
 * slug in `vendor/model` form, resolvable through `GET /models`.
 */
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';

export type OpenRouterProviderOptions = {
  /** Falls back to `OPENROUTER_API_KEY`. */
  apiKey?: string;
  /** Falls back to `OPENROUTER_BASE_URL`, then the public gateway. */
  baseURL?: string;
  /** Falls back to `OPENROUTER_MODEL`, then `DEFAULT_OPENROUTER_MODEL`. */
  defaultModel?: string;
  /** Sent as `HTTP-Referer` for OpenRouter app attribution. */
  appUrl?: string;
  /** Sent as `X-OpenRouter-Title` for OpenRouter app attribution. */
  appName?: string;
  /** Ordered fallback slugs OpenRouter may route to when the primary fails. */
  fallbackModels?: readonly string[];
  /** Restrict or order upstream providers, e.g. `{ order: ['anthropic'] }`. */
  providerRouting?: Readonly<Record<string, unknown>>;
  defaultHeaders?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
};

/** Normalized view of one entry from OpenRouter `GET /models`. */
export type OpenRouterModel = {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens?: number;
  supportsTools: boolean;
  inputModalities: readonly string[];
  promptUsdPerToken?: number;
  completionUsdPerToken?: number;
};

export type ListOpenRouterModelsOptions = {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Keep only models advertising tool/function calling. */
  toolCapableOnly?: boolean;
};

/**
 * OpenRouter model provider. OpenRouter speaks the OpenAI chat-completions
 * protocol, so streaming, tool calls, and usage translation are delegated to
 * {@link OpenAICompatibleModelProvider}; this class owns credential defaults,
 * attribution headers, routing preferences, and catalog lookups.
 */
export class OpenRouterModelProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly defaultModel: string;
  readonly baseURL: string;
  private readonly apiKey: string;
  private readonly delegate: OpenAICompatibleModelProvider;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpenRouterProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey.trim()) {
      throw new AgentHarnessError(
        'OpenRouter provider requires an API key: set OPENROUTER_API_KEY or pass apiKey',
        'MISSING_MODEL_CREDENTIAL',
      );
    }
    this.apiKey = apiKey;
    this.baseURL = options.baseURL ?? process.env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL;
    this.defaultModel =
      options.defaultModel ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    const routing = openRouterRouting(options);
    this.delegate = new OpenAICompatibleModelProvider({
      name: 'openrouter',
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      defaultModel: this.defaultModel,
      // OpenRouter normalizes on `max_tokens` across every upstream vendor.
      maxTokensField: 'max_tokens',
      defaultHeaders: openRouterHeaders(options),
      ...(routing === undefined ? {} : { extraBody: routing }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return this.delegate.stream(request);
  }

  /** Live catalog of models this key can route to. */
  async listModels(
    options: Omit<ListOpenRouterModelsOptions, 'apiKey' | 'baseURL' | 'fetch'> = {},
  ): Promise<OpenRouterModel[]> {
    return listOpenRouterModels({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      fetch: this.fetchImplementation,
      ...options,
    });
  }

  /** Resolve a single slug, or `undefined` when OpenRouter does not serve it. */
  async findModel(model: string, signal?: AbortSignal): Promise<OpenRouterModel | undefined> {
    const models = await this.listModels(signal === undefined ? {} : { signal });
    return models.find((candidate) => candidate.id === model);
  }

  /**
   * Fail fast when a configured slug is not routable, instead of surfacing a
   * 404 mid-stream on the first turn.
   */
  async assertModelAvailable(model = this.defaultModel, signal?: AbortSignal): Promise<void> {
    const found = await this.findModel(model, signal);
    if (!found) {
      throw new AgentHarnessError(
        `Model is not available on OpenRouter: ${model}`,
        'UNKNOWN_MODEL',
      );
    }
  }
}

/**
 * Preset factory kept for call sites that configure a provider inline.
 */
export function createOpenRouterProvider(
  options: OpenRouterProviderOptions = {},
): OpenRouterModelProvider {
  return new OpenRouterModelProvider(options);
}

export async function listOpenRouterModels(
  options: ListOpenRouterModelsOptions = {},
): Promise<OpenRouterModel[]> {
  const baseURL = (
    options.baseURL ??
    process.env.OPENROUTER_BASE_URL ??
    OPENROUTER_BASE_URL
  ).replace(/\/$/, '');
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(`${baseURL}/models`, {
    method: 'GET',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: {
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw Object.assign(
      new AgentHarnessError(
        `OpenRouter model listing failed (${response.status}): ${detail || response.statusText}`,
        'MODEL_CATALOG_ERROR',
        response.status === 429 || response.status >= 500,
      ),
      { status: response.status },
    );
  }
  const payload: unknown = await response.json();
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new AgentHarnessError('OpenRouter model listing was malformed', 'MODEL_CATALOG_ERROR');
  }
  const models = data.flatMap((entry) => {
    const model = toOpenRouterModel(entry);
    return model ? [model] : [];
  });
  return options.toolCapableOnly ? models.filter((model) => model.supportsTools) : models;
}

function openRouterHeaders(options: OpenRouterProviderOptions): Record<string, string> {
  const appUrl = options.appUrl ?? process.env.OPENROUTER_APP_URL;
  const appName = options.appName ?? process.env.OPENROUTER_APP_NAME;
  return {
    ...(appUrl === undefined ? {} : { 'HTTP-Referer': appUrl }),
    ...(appName === undefined ? {} : { 'X-OpenRouter-Title': appName }),
    ...options.defaultHeaders,
  };
}

function openRouterRouting(
  options: OpenRouterProviderOptions,
): Record<string, unknown> | undefined {
  const models = options.fallbackModels?.filter((model) => model.trim().length > 0) ?? [];
  const body: Record<string, unknown> = {};
  if (models.length) body.models = [...models];
  if (options.providerRouting) body.provider = options.providerRouting;
  return Object.keys(body).length ? body : undefined;
}

function toOpenRouterModel(value: unknown): OpenRouterModel | undefined {
  const entry = asRecord(value);
  if (!entry || typeof entry.id !== 'string') return undefined;
  const architecture = asRecord(entry.architecture);
  const pricing = asRecord(entry.pricing);
  const topProvider = asRecord(entry.top_provider);
  const supportedParameters = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters
    : [];
  const maxCompletionTokens = numberOrUndefined(topProvider?.max_completion_tokens);
  const promptUsdPerToken = priceOrUndefined(pricing?.prompt);
  const completionUsdPerToken = priceOrUndefined(pricing?.completion);
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : entry.id,
    contextLength:
      numberOrUndefined(entry.context_length) ??
      numberOrUndefined(topProvider?.context_length) ??
      0,
    supportsTools: supportedParameters.includes('tools'),
    inputModalities: Array.isArray(architecture?.input_modalities)
      ? architecture.input_modalities.filter((item): item is string => typeof item === 'string')
      : [],
    ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }),
    ...(promptUsdPerToken === undefined ? {} : { promptUsdPerToken }),
    ...(completionUsdPerToken === undefined ? {} : { completionUsdPerToken }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function priceOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

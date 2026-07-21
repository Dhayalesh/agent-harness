import { AnthropicModelProvider } from '../models/anthropic-provider.js';
import { OpenAICompatibleModelProvider } from '../models/openai-compatible-provider.js';
import type { ModelProvider } from '../models/provider.js';
import { RetryModelProvider } from '../models/retry-provider.js';
import type { ModelBinding } from './definitions.js';
import type { PlatformSecretResolver } from './catalogs.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface PlatformModelResolver {
  resolve(tenantId: string, binding: ModelBinding): Promise<ModelProvider>;
}

export type DefaultPlatformModelResolverOptions = {
  allowedCustomBaseURLs?: ReadonlySet<string>;
};

export class DefaultPlatformModelResolver implements PlatformModelResolver {
  constructor(
    private readonly secrets: PlatformSecretResolver,
    private readonly options: DefaultPlatformModelResolverOptions = {},
  ) {}

  async resolve(tenantId: string, binding: ModelBinding): Promise<ModelProvider> {
    const apiKey = await this.secrets.get(tenantId, binding.secretRef);
    if (!apiKey) throw new Error(`Missing model credential: ${binding.secretRef}`);
    if (binding.provider === 'anthropic') {
      if (binding.baseURL) this.assertAllowedCustomBaseURL(binding.baseURL);
      return new RetryModelProvider(
        new AnthropicModelProvider({
          apiKey,
          defaultModel: binding.model,
          ...(binding.baseURL === undefined ? {} : { baseURL: binding.baseURL }),
        }),
      );
    }
    const baseURL =
      binding.provider === 'openrouter'
        ? (binding.baseURL ?? OPENROUTER_BASE_URL)
        : binding.baseURL;
    if (!baseURL) throw new Error('OpenAI-compatible model binding requires baseURL');
    if (
      binding.provider === 'openai-compatible' ||
      (binding.baseURL && normalizeBaseURL(binding.baseURL) !== OPENROUTER_BASE_URL)
    ) {
      this.assertAllowedCustomBaseURL(baseURL);
    }
    return new RetryModelProvider(
      new OpenAICompatibleModelProvider({
        name: binding.provider,
        apiKey,
        baseURL,
        defaultModel: binding.model,
        defaultHeaders: safeModelHeaders(binding.headers),
      }),
    );
  }

  private assertAllowedCustomBaseURL(value: string): void {
    const normalized = normalizeBaseURL(value);
    const allowed = [...(this.options.allowedCustomBaseURLs ?? [])].some(
      (candidate) => normalizeBaseURL(candidate) === normalized,
    );
    if (!allowed) throw new Error(`Model base URL is not trusted by this platform: ${normalized}`);
  }
}

function normalizeBaseURL(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Model base URL cannot contain credentials');
  return url.toString().replace(/\/$/, '');
}

function safeModelHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const safe = new Set(['HTTP-Referer', 'X-OpenRouter-Title', 'X-OpenRouter-Categories']);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => safe.has(name)));
}

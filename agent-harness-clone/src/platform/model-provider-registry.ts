import { AgentHarnessError } from '../core/errors.js';
import { OpenAICompatibleModelProvider } from '../models/openai-compatible-provider.js';
import { OPENROUTER_BASE_URL, OpenRouterModelProvider } from '../models/openrouter-provider.js';
import type { ModelProvider } from '../models/provider.js';
import { RetryModelProvider } from '../models/retry-provider.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import type { ModelProviderRecord } from './model-provider-definitions.js';
import { RUNTIME_SUPPORT, assertRuntimeSupport } from './model-provider-support.js';

/** The read surface the registry needs; satisfied by `MongoModelProviderStore`. */
export interface ModelProviderLookup {
  get(id: string): Promise<ModelProviderRecord | undefined>;
  getByName(name: string): Promise<ModelProviderRecord | undefined>;
  getDefault(): Promise<ModelProviderRecord | undefined>;
}

export type PlatformModelProviderRegistryOptions = {
  /** Defaults to `console.warn`. */
  logger?: (message: string) => void;
  logSink?: LogSink;
  logContext?: LogContext;
};

/**
 * Named to avoid colliding with `ModelProviderRegistry` in
 * `src/models/registry.ts`, which is an unrelated in-process plugin registry.
 */
export class PlatformModelProviderRegistry {
  private readonly logger: (message: string) => void;

  constructor(
    private readonly store: ModelProviderLookup,
    private readonly options: PlatformModelProviderRegistryOptions = {},
  ) {
    this.logger = options.logger ?? ((message) => console.warn(message));
  }

  async resolveById(id: string): Promise<ModelProvider> {
    const record = await this.store.get(id);
    if (!record) {
      throw new AgentHarnessError(`Unknown model provider: ${id}`, 'MODEL_PROVIDER_NOT_FOUND');
    }
    return this.resolveRecord(record);
  }

  async resolveByName(name: string): Promise<ModelProvider> {
    const record = await this.store.getByName(name);
    if (!record) {
      throw new AgentHarnessError(`Unknown model provider: ${name}`, 'MODEL_PROVIDER_NOT_FOUND');
    }
    return this.resolveRecord(record);
  }

  async resolveDefault(): Promise<ModelProvider> {
    const record = await this.store.getDefault();
    if (!record) {
      throw new AgentHarnessError('No default model provider', 'MODEL_PROVIDER_NOT_FOUND');
    }
    return this.resolveRecord(record);
  }

  async resolveRecord(record: ModelProviderRecord): Promise<ModelProvider> {
    // Defence in depth: a record may predate a change to RUNTIME_SUPPORT.
    assertRuntimeSupport(record);
    if (!record.enabled) {
      throw new AgentHarnessError(
        `Model provider is disabled: ${record.name}`,
        'MODEL_PROVIDER_DISABLED',
      );
    }

    const baseURL =
      record.provider === 'openrouter' ? (record.baseURL ?? OPENROUTER_BASE_URL) : record.baseURL;
    if (!baseURL) {
      throw new AgentHarnessError(
        `Model provider requires baseURL: ${record.name}`,
        'MODEL_PROVIDER_BASE_URL_MISSING',
      );
    }
    assertUsableBaseURL(baseURL);

    const apiKey = resolveCredential(record);

    const ignored = ignoredCapabilities(record);
    if (ignored.length > 0) {
      this.warning(
        `[model-provider-registry] stored capabilities for '${record.name}' are not in effect: ` +
          `${ignored.join(', ')}. ` +
          'ModelProvider carries no capability surface (src/models/provider.ts:36).',
        record.name,
      );
    }

    // Asking for deliberation is what the capability decides: a record that says
    // the model does not reason should not spend tokens proving it.
    const reasoning = {
      ...(record.capabilities.supportsReasoning ? { requestReasoning: true } : {}),
      ...(record.wire?.reasoningField === undefined
        ? {}
        : { reasoningField: record.wire.reasoningField }),
    };

    if (record.provider === 'openrouter') {
      return new RetryModelProvider(
        new OpenRouterModelProvider({
          apiKey,
          baseURL,
          defaultModel: record.model,
          defaultHeaders: { ...record.headers },
          ...reasoning,
        }),
        {
          ...(this.options.logSink === undefined ? {} : { logSink: this.options.logSink }),
          ...(this.options.logContext === undefined ? {} : { logContext: this.options.logContext }),
        },
      );
    }
    return new RetryModelProvider(
      new OpenAICompatibleModelProvider({
        name: record.provider,
        apiKey,
        baseURL,
        defaultModel: record.model,
        defaultHeaders: { ...record.headers },
        ...(record.wire?.maxTokensField === undefined
          ? {}
          : { maxTokensField: record.wire.maxTokensField }),
        ...reasoning,
      }),
      {
        ...(this.options.logSink === undefined ? {} : { logSink: this.options.logSink }),
        ...(this.options.logContext === undefined ? {} : { logContext: this.options.logContext }),
      },
    );
  }

  private warning(message: string, provider: string): void {
    this.logger(message);
    emitLog(this.options.logSink, {
      ...(this.options.logContext ?? {}),
      level: 'warn',
      event: 'model.configuration.warning',
      provider,
      message,
    });
  }
}

/**
 * `name=value` for every stored capability the runtime does not act on, so the
 * warning names exactly what is dropped and stays silent about what is not.
 */
function ignoredCapabilities(record: ModelProviderRecord): string[] {
  const honoured: readonly string[] = RUNTIME_SUPPORT.capabilitiesHonoured;
  return Object.entries(record.capabilities)
    .filter(([name]) => !honoured.includes(name))
    .map(([name, value]) => `${name}=${value}`);
}

/** The credential is on the record; there is nowhere else left to look. */
function resolveCredential(record: ModelProviderRecord): string {
  if (!record.apiKey) {
    throw new AgentHarnessError(
      `Model provider requires apiKey: ${record.name}`,
      'MISSING_MODEL_CREDENTIAL',
    );
  }
  return record.apiKey;
}

/**
 * No allowlist backs the endpoint any more, so the record is trusted as written:
 * whoever can write `baseURL` decides where `apiKey` is sent. The one remaining
 * check is that the URL cannot carry credentials of its own, which would smuggle
 * a second secret past the record.
 */
function assertUsableBaseURL(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new AgentHarnessError(
      'Model base URL cannot contain credentials',
      'MODEL_BASE_URL_INVALID',
    );
  }
}

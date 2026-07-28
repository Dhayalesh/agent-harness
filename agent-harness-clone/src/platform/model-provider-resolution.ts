import { AgentHarnessError } from '../core/errors.js';
import type { ModelProvider } from '../models/provider.js';
import type { ModelProviderRecord } from './model-provider-definitions.js';
import { PlatformModelProviderRegistry } from './model-provider-registry.js';
import { MongoModelProviderStore } from './model-provider-store.js';

/**
 * Where the runnable entrypoints look for their LLM. The database is the only
 * source: there is no environment-supplied model or credential fallback, so a
 * stray variable cannot silently redirect a run to an unconfigured model.
 */
export type ModelProviderEnvironmentConfig = {
  uri: string;
  databaseName: string;
  /** Record `name`. Unset selects the default record. */
  providerName?: string;
};

export function modelProviderConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelProviderEnvironmentConfig {
  const providerName = environment.PLATFORM_MODEL_PROVIDER?.trim();
  const uri = required(environment, 'PLATFORM_MONGODB_URI');
  return {
    uri,
    databaseName: databaseNameFromUri(uri),
    ...(providerName ? { providerName } : {}),
  };
}

/**
 * The database name lives in the connection string's path segment, so one
 * variable carries the whole location and the two halves cannot drift apart.
 */
export function databaseNameFromUri(uri: string): string {
  const afterScheme = uri.slice(uri.indexOf('://') + 3);
  const afterCredentials = afterScheme.slice(afterScheme.lastIndexOf('@') + 1);
  const separator = afterCredentials.indexOf('/');
  const path = separator === -1 ? '' : afterCredentials.slice(separator + 1);
  const name = decodeURIComponent(path.split(/[?#]/, 1)[0] ?? '').trim();
  if (!name) {
    throw new AgentHarnessError(
      'PLATFORM_MONGODB_URI must name a database, as in ' +
        'mongodb://127.0.0.1:27017/trueai_agent_platform',
      'MODEL_PROVIDER_CONFIG_MISSING',
    );
  }
  return name;
}

export type ResolvedModelProvider = {
  provider: ModelProvider;
  record: ModelProviderRecord;
  /** Releases the Mongo connection opened for the lookup. */
  close(): Promise<void>;
};

/**
 * Reads one `model_providers` record and builds the provider it describes. The
 * record carries the model, the endpoint, and the credential, so this single
 * document is the whole configuration and the whole trust boundary.
 */
export async function resolveModelProviderFromDatabase(
  config: ModelProviderEnvironmentConfig = modelProviderConfigFromEnvironment(),
): Promise<ResolvedModelProvider> {
  const store = await MongoModelProviderStore.connect(config.uri, config.databaseName);
  try {
    const record =
      config.providerName === undefined
        ? await store.getDefault()
        : await store.getByName(config.providerName);
    if (!record) {
      throw new AgentHarnessError(
        config.providerName === undefined
          ? `No enabled default model provider in ${config.databaseName}.model_providers`
          : `Unknown model provider '${config.providerName}' in ` +
              `${config.databaseName}.model_providers`,
        'MODEL_PROVIDER_NOT_FOUND',
      );
    }
    const provider = await new PlatformModelProviderRegistry(store).resolveRecord(record);
    return { provider, record, close: () => store.close() };
  } catch (error) {
    await store.close();
    throw error;
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AgentHarnessError(
      `${name} is required: the model provider is read from the database only`,
      'MODEL_PROVIDER_CONFIG_MISSING',
    );
  }
  return value;
}

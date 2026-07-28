import { OpenRouterModelProvider } from '../models/openrouter-provider.js';
import type { SecretProvider } from './secrets.js';

export async function createOpenRouterProviderFromSecrets(
  secrets: SecretProvider,
  options: {
    /** Required: the provider no longer infers a model from the environment. */
    model: string;
    secretName?: string;
    baseURL?: string;
    appUrl?: string;
    appName?: string;
  },
): Promise<OpenRouterModelProvider> {
  const secretName = options.secretName ?? 'OPENROUTER_API_KEY';
  const apiKey = await secrets.get(secretName);
  if (!apiKey) throw new Error(`Missing provider credential: ${secretName}`);
  return new OpenRouterModelProvider({
    apiKey,
    defaultModel: options.model,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
    ...(options.appName === undefined ? {} : { appName: options.appName }),
  });
}

import { AnthropicModelProvider } from '../models/anthropic-provider.js';
import type { SecretProvider } from './secrets.js';

export async function createAnthropicProviderFromSecrets(
  secrets: SecretProvider,
  options: { secretName?: string; model?: string; baseURL?: string } = {},
): Promise<AnthropicModelProvider> {
  const secretName = options.secretName ?? 'ANTHROPIC_API_KEY';
  const apiKey = await secrets.get(secretName);
  if (!apiKey) throw new Error(`Missing provider credential: ${secretName}`);
  return new AnthropicModelProvider({
    apiKey,
    ...(options.model === undefined ? {} : { defaultModel: options.model }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
  });
}

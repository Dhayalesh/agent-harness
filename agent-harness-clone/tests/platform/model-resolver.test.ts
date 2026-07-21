import assert from 'node:assert/strict';
import test from 'node:test';
import { DefaultPlatformModelResolver, InMemoryPlatformSecretResolver } from '../../src/index.js';

const secrets = new InMemoryPlatformSecretResolver({
  tenant: { MODEL_KEY: 'secret' },
});

test('platform model resolver uses canonical OpenRouter without trusting DB-supplied URLs', async () => {
  const resolver = new DefaultPlatformModelResolver(secrets);
  await resolver.resolve('tenant', {
    provider: 'openrouter',
    model: 'test/model',
    secretRef: 'MODEL_KEY',
  });
  await assert.rejects(
    resolver.resolve('tenant', {
      provider: 'openrouter',
      model: 'test/model',
      secretRef: 'MODEL_KEY',
      baseURL: 'https://untrusted.example/v1',
    }),
    /not trusted/,
  );
});

test('operator allowlist controls custom OpenAI-compatible model endpoints', async () => {
  const resolver = new DefaultPlatformModelResolver(secrets, {
    allowedCustomBaseURLs: new Set(['https://models.internal.example/v1/']),
  });
  await resolver.resolve('tenant', {
    provider: 'openai-compatible',
    model: 'internal-model',
    secretRef: 'MODEL_KEY',
    baseURL: 'https://models.internal.example/v1',
  });
  await assert.rejects(
    resolver.resolve('tenant', {
      provider: 'openai-compatible',
      model: 'internal-model',
      secretRef: 'MODEL_KEY',
      baseURL: 'https://metadata.invalid',
    }),
    /not trusted/,
  );
});

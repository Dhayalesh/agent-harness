import type { ModelProvider } from './provider.js';

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(initialProviders: readonly ModelProvider[] = []) {
    for (const provider of initialProviders) this.register(provider);
  }

  register(provider: ModelProvider): () => void {
    if (!provider.name.trim()) throw new Error('Model provider requires a name');
    if (this.providers.has(provider.name)) {
      throw new Error(`Model provider already registered: ${provider.name}`);
    }
    this.providers.set(provider.name, provider);
    return () => this.providers.delete(provider.name);
  }

  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  list(): readonly ModelProvider[] {
    return [...this.providers.values()];
  }
}

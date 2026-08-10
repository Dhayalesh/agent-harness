import type { SessionStore, StoredSession } from './session-store.js';

/** S3 (or another durable store) as authority, with a fail-open local cache. */
export class TieredSessionStore implements SessionStore {
  readonly kind = 's3' as const;
  private readonly hydrated = new Set<string>();

  constructor(
    private readonly cache: SessionStore,
    private readonly durable: SessionStore & { destroy?(): void },
  ) {}

  async load(id: string): Promise<StoredSession | undefined> {
    if (this.hydrated.has(id)) {
      const cached = await this.cache.load(id);
      if (cached) return cached;
    }

    const durable = await this.durable.load(id);
    if (durable) {
      await this.cache.save(durable).catch(() => undefined);
      this.hydrated.add(id);
      return durable;
    }

    // Promotes a pre-S3 local session during a rolling deployment. Once promoted,
    // every later load in this process treats the durable store as authoritative.
    const legacy = await this.cache.load(id);
    if (legacy) {
      await this.durable.save(legacy);
      this.hydrated.add(id);
      return legacy;
    }
    this.hydrated.add(id);
    return undefined;
  }

  async save(session: StoredSession): Promise<void> {
    // Durable first: a cache write can be reconstructed, while an acknowledged
    // local-only write would create a false promise that the session is permanent.
    await this.durable.save(session);
    await this.cache.save(session).catch(async () => {
      await this.cache.delete(session.id).catch(() => undefined);
    });
    this.hydrated.add(session.id);
  }

  async delete(id: string): Promise<boolean> {
    const durableDeleted = await this.durable.delete(id);
    const cacheDeleted = await this.cache.delete(id).catch(() => false);
    this.hydrated.delete(id);
    return durableDeleted || cacheDeleted;
  }

  list(): ReturnType<SessionStore['list']> {
    return this.durable.list();
  }

  destroy(): void {
    this.durable.destroy?.();
  }
}

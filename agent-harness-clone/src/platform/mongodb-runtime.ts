import type { Collection, Db, MongoClient as MongoClientType } from 'mongodb';
import { MongoServerError } from 'mongodb';
import type { AgentEvent } from '../core/events.js';
import type { StoredSession } from '../sessions/session-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import type {
  PlatformRunRecord,
  PlatformRuntimeStore,
  PlatformSessionRecord,
  StoredPlatformEvent,
} from './runtime-state.js';

type TenantSessionDocument = StoredSession & { tenantId: string };

export class MongoTenantSessionStore implements SessionStore {
  private readonly sessions: Collection<TenantSessionDocument>;

  constructor(
    database: Db,
    private readonly tenantId: string,
  ) {
    this.sessions = database.collection<TenantSessionDocument>('agent_sessions');
  }

  async initialize(): Promise<void> {
    await this.sessions.createIndex({ tenantId: 1, id: 1 }, { unique: true });
  }

  async load(id: string): Promise<StoredSession | undefined> {
    return clean(await this.sessions.findOne({ tenantId: this.tenantId, id }));
  }

  async save(session: StoredSession): Promise<void> {
    await this.sessions.replaceOne(
      { tenantId: this.tenantId, id: session.id },
      { ...structuredClone(session), tenantId: this.tenantId },
      { upsert: true },
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.sessions.deleteOne({ tenantId: this.tenantId, id });
    return result.deletedCount === 1;
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    const values = await this.sessions
      .find({ tenantId: this.tenantId })
      .sort({ updatedAt: -1 })
      .toArray();
    return values.map(({ id, createdAt, updatedAt, metadata }) => ({
      id,
      createdAt,
      updatedAt,
      metadata: structuredClone(metadata),
    }));
  }
}

export type MongoPlatformRuntimeStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export class MongoPlatformRuntimeStore implements PlatformRuntimeStore {
  readonly database: Db;
  private readonly sessions: Collection<PlatformSessionRecord>;
  private readonly runs: Collection<PlatformRunRecord>;
  private readonly events: Collection<StoredPlatformEvent>;

  constructor(private readonly options: MongoPlatformRuntimeStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.sessions = this.database.collection<PlatformSessionRecord>('platform_sessions');
    this.runs = this.database.collection<PlatformRunRecord>('platform_runs');
    this.events = this.database.collection<StoredPlatformEvent>('platform_events');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.sessions.createIndex({ tenantId: 1, sessionId: 1 }, { unique: true }),
      this.sessions.createIndex({ tenantId: 1, ownerId: 1, updatedAt: -1 }),
      this.runs.createIndex({ tenantId: 1, sessionId: 1, runId: 1 }, { unique: true }),
      this.events.createIndex({ tenantId: 1, sessionId: 1, sequence: 1 }, { unique: true }),
      this.events.createIndex({ tenantId: 1, sessionId: 1, runId: 1, sequence: 1 }),
    ]);
    await new MongoTenantSessionStore(this.database, '__index_initializer__').initialize();
  }

  async recoverOrphanedRuns(updatedAt: string): Promise<number> {
    const result = await this.runs.updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'failed',
          updatedAt,
          error: 'API process stopped before the run completed',
        },
      },
    );
    return result.modifiedCount;
  }

  async createSession(record: PlatformSessionRecord): Promise<void> {
    await this.sessions.insertOne(structuredClone(record));
  }

  async getSession(
    tenantId: string,
    sessionId: string,
  ): Promise<PlatformSessionRecord | undefined> {
    return clean(await this.sessions.findOne({ tenantId, sessionId }));
  }

  async listSessions(
    tenantId: string,
    ownerId?: string,
    limit = 100,
  ): Promise<PlatformSessionRecord[]> {
    const values = await this.sessions
      .find({ tenantId, ...(ownerId === undefined ? {} : { ownerId }) })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return values.map((value) => clean(value) as PlatformSessionRecord);
  }

  async closeSession(tenantId: string, sessionId: string, updatedAt: string): Promise<boolean> {
    const result = await this.sessions.updateOne(
      { tenantId, sessionId },
      { $set: { status: 'closed', updatedAt } },
    );
    return result.matchedCount === 1;
  }

  async claimRun(record: PlatformRunRecord): Promise<boolean> {
    try {
      await this.runs.insertOne(structuredClone(record));
      return true;
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) return false;
      throw error;
    }
  }

  async getRun(
    tenantId: string,
    sessionId: string,
    runId: string,
  ): Promise<PlatformRunRecord | undefined> {
    return clean(await this.runs.findOne({ tenantId, sessionId, runId }));
  }

  async finishRun(
    tenantId: string,
    sessionId: string,
    runId: string,
    status: Exclude<PlatformRunRecord['status'], 'running'>,
    updatedAt: string,
    error?: string,
  ): Promise<void> {
    const result = await this.runs.updateOne(
      { tenantId, sessionId, runId },
      {
        $set: {
          status,
          updatedAt,
          ...(error === undefined ? {} : { error }),
        },
      },
    );
    if (result.matchedCount !== 1) throw new Error(`Unknown platform run: ${runId}`);
  }

  async appendEvent(record: StoredPlatformEvent): Promise<void> {
    await this.events.insertOne(structuredClone(record));
  }

  async listEvents(tenantId: string, sessionId: string, afterSequence = 0): Promise<AgentEvent[]> {
    const values = await this.events
      .find({ tenantId, sessionId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .toArray();
    return values.map((record) => structuredClone(record.event));
  }

  async listRunEvents(tenantId: string, sessionId: string, runId: string): Promise<AgentEvent[]> {
    const values = await this.events
      .find({ tenantId, sessionId, runId })
      .sort({ sequence: 1 })
      .toArray();
    return values.map((record) => structuredClone(record.event));
  }

  async close(): Promise<void> {
    if (this.options.closeClient) await this.options.client.close();
  }
}

function clean<T>(value: (T & { _id?: unknown }) | null): T | undefined {
  if (!value) return undefined;
  const { _id: _unused, ...document } = value;
  return structuredClone(document) as T;
}

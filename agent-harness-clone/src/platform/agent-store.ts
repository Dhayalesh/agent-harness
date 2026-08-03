import type { Collection, Db, Filter, MongoClient as MongoClientType, WithId } from 'mongodb';
import { MongoClient, ObjectId } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import type { AgentRecord, AgentUpdate } from './agent-definitions.js';
import {
  nowIso,
  parseAgentInput,
  parseAgentRecord,
  parseAgentUpdate,
} from './agent-definitions.js';
import { assertAgentRuntimeSupport } from './agent-support.js';
import { PLATFORM_MONGO_APP_NAME } from './model-provider-store.js';

export const AGENTS_COLLECTION = 'agents';

export type MongoAgentStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export type AgentListOptions = {
  enabledOnly?: boolean;
  cursor?: string;
  limit?: number;
};

/** A record as stored: the validated fields plus the `_id` MongoDB assigned. */
export type StoredAgentRecord = WithId<AgentRecord>;

/**
 * Store for agent configurations.
 *
 * The collection holds one flat set of records keyed by `_id` and by `name`.
 * There is no unscoped `find` and no unscoped `updateMany`.
 *
 * Unlike `model_providers` and `mcp_servers` these records hold no credential:
 * the key for the model stays on the referenced `model_providers` record and the
 * keys for MCP stay on the referenced `mcp_servers` records. Reads here are
 * therefore safe to expose, and `list` output needs no field stripped.
 *
 * As with `model_providers` there is one default record rather than a composing
 * flag: an agent is selected for a run, not merged with others, so `isDefault`
 * is kept unique by the store.
 */
export class MongoAgentStore {
  private readonly database: Db;
  private readonly agents: Collection<AgentRecord>;

  constructor(private readonly options: MongoAgentStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.agents = this.database.collection<AgentRecord>(AGENTS_COLLECTION);
  }

  static async connect(uri: string, databaseName: string): Promise<MongoAgentStore> {
    const client = new MongoClient(uri, { appName: PLATFORM_MONGO_APP_NAME });
    await client.connect();
    return new MongoAgentStore({ client, databaseName, closeClient: true });
  }

  async initialize(): Promise<void> {
    // `_id` needs no index here: MongoDB creates a unique one for it.
    await Promise.all([
      this.agents.createIndex({ name: 1 }, { unique: true }),
      this.agents.createIndex({ enabled: 1 }),
    ]);
  }

  async create(createdBy: string, input: unknown): Promise<StoredAgentRecord> {
    const parsed = parseAgentInput(input);
    assertAgentRuntimeSupport(parsed);
    const timestamp = nowIso();
    const record = parseAgentRecord({
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy,
    });
    if (await this.getByName(record.name)) {
      throw new AgentHarnessError(
        `Agent name already exists: ${record.name}`,
        'AGENT_NAME_CONFLICT',
      );
    }
    if (record.isDefault) await this.clearDefault();
    // MongoDB assigns `_id`, so the id exists only once and only after the write.
    const result = await this.agents.insertOne(structuredClone(record));
    return { _id: result.insertedId, ...record };
  }

  async get(id: string): Promise<StoredAgentRecord | undefined> {
    const objectId = toObjectId(id);
    if (!objectId) return undefined;
    return clean(await this.agents.findOne({ _id: objectId }));
  }

  async getByName(name: string): Promise<StoredAgentRecord | undefined> {
    return clean(await this.agents.findOne({ name }));
  }

  /**
   * The record a run picks when no name is given. Disabled records are excluded,
   * so an agent that was switched off cannot keep being selected by default.
   */
  async getDefault(): Promise<StoredAgentRecord | undefined> {
    return clean(await this.agents.findOne({ isDefault: true, enabled: true }));
  }

  async list(options: AgentListOptions = {}): Promise<StoredAgentRecord[]> {
    const cursor = options.cursor === undefined ? undefined : toObjectId(options.cursor);
    const filter: Filter<AgentRecord> = {
      ...(options.enabledOnly ? { enabled: true } : {}),
      ...(cursor === undefined ? {} : { _id: { $gt: cursor } }),
    };
    const values = await this.agents
      .find(filter)
      .sort({ _id: 1 })
      .limit(options.limit ?? 100)
      .toArray();
    return values.map((value) => clean(value) as StoredAgentRecord);
  }

  /**
   * Applies a patch, then re-validates the whole merged record so a partial
   * update cannot bypass a cross-field invariant or the runtime support gate.
   */
  async update(id: string, patch: unknown): Promise<StoredAgentRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const parsedPatch: AgentUpdate = parseAgentUpdate(patch);
    // `_id` is not part of the validated shape, so it is set aside and put back.
    const { _id: objectId, ...current } = existing;
    const merged = parseAgentRecord({
      ...current,
      ...stripUndefined(parsedPatch),
      updatedAt: nowIso(),
    });
    assertAgentRuntimeSupport(merged);
    if (merged.name !== existing.name) {
      const conflict = await this.getByName(merged.name);
      if (conflict && !conflict._id.equals(objectId)) {
        throw new AgentHarnessError(
          `Agent name already exists: ${merged.name}`,
          'AGENT_NAME_CONFLICT',
        );
      }
    }
    if (merged.isDefault) await this.clearDefault(objectId);
    await this.agents.replaceOne({ _id: objectId }, structuredClone(merged));
    return { _id: objectId, ...merged };
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.agents.updateOne(
      { _id: objectId },
      { $set: { enabled, updatedAt: nowIso() } },
    );
    return result.matchedCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.agents.deleteOne({ _id: objectId });
    return result.deletedCount === 1;
  }

  async close(): Promise<void> {
    if (this.options.closeClient) await this.options.client.close();
  }

  /** Keeps at most one default; `exceptId` keeps the incoming default set. */
  private async clearDefault(exceptId?: ObjectId): Promise<void> {
    await this.agents.updateMany(
      {
        isDefault: true,
        ...(exceptId === undefined ? {} : { _id: { $ne: exceptId } }),
      },
      { $set: { isDefault: false, updatedAt: nowIso() } },
    );
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Partial<T>;
}

/**
 * A read keeps `_id`, since it is the record's id. It is carried across by
 * reference rather than cloned, because `structuredClone` would flatten the
 * `ObjectId` into a plain object; the rest is copied as before.
 */
function clean<T extends { _id: unknown }>(value: T | null): T | undefined {
  if (value === null) return undefined;
  const { _id, ...document } = value;
  return { _id, ...structuredClone(document) } as T;
}

/**
 * A record id is the 24-character hex form of an `ObjectId`. Anything else cannot
 * name a document, so it reads as absent instead of throwing.
 */
function toObjectId(id: string): ObjectId | undefined {
  return ObjectId.isValid(id) && new ObjectId(id).toHexString() === id
    ? new ObjectId(id)
    : undefined;
}

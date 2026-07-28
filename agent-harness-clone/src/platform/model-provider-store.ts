import type { Collection, Db, Filter, MongoClient as MongoClientType, WithId } from 'mongodb';
import { MongoClient, ObjectId } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import type { ModelProviderRecord, ModelProviderUpdate } from './model-provider-definitions.js';
import {
  nowIso,
  parseModelProviderInput,
  parseModelProviderRecord,
  parseModelProviderUpdate,
} from './model-provider-definitions.js';
import { assertRuntimeSupport } from './model-provider-support.js';

export const MODEL_PROVIDERS_COLLECTION = 'model_providers';

/** Reported to MongoDB by stores that open their own client. */
export const PLATFORM_MONGO_APP_NAME = 'trueai-agent-platform';

export type MongoModelProviderStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export type ModelProviderListOptions = {
  enabledOnly?: boolean;
  cursor?: string;
  limit?: number;
};

/** A record as stored: the validated fields plus the `_id` MongoDB assigned. */
export type StoredModelProviderRecord = WithId<ModelProviderRecord>;

/**
 * Store for LLM provider configurations.
 *
 * The collection holds one flat set of records keyed by `_id` and by `name`.
 * There is no unscoped `find` and no unscoped `updateMany`.
 *
 * Records hold the credential in `apiKey`, so every read here returns a secret.
 * Do not expose `get`, `getByName`, `getDefault`, or `list` output on an API
 * surface without stripping that field first.
 */
export class MongoModelProviderStore {
  private readonly database: Db;
  private readonly providers: Collection<ModelProviderRecord>;

  constructor(private readonly options: MongoModelProviderStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.providers = this.database.collection<ModelProviderRecord>(MODEL_PROVIDERS_COLLECTION);
  }

  static async connect(uri: string, databaseName: string): Promise<MongoModelProviderStore> {
    const client = new MongoClient(uri, { appName: PLATFORM_MONGO_APP_NAME });
    await client.connect();
    return new MongoModelProviderStore({ client, databaseName, closeClient: true });
  }

  async initialize(): Promise<void> {
    // `_id` needs no index here: MongoDB creates a unique one for it.
    await Promise.all([
      this.providers.createIndex({ name: 1 }, { unique: true }),
      this.providers.createIndex({ enabled: 1 }),
    ]);
  }

  async create(createdBy: string, input: unknown): Promise<StoredModelProviderRecord> {
    const parsed = parseModelProviderInput(input);
    assertRuntimeSupport(parsed);
    const timestamp = nowIso();
    const record = parseModelProviderRecord({
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy,
    });
    if (await this.getByName(record.name)) {
      throw new AgentHarnessError(
        `Model provider name already exists: ${record.name}`,
        'MODEL_PROVIDER_NAME_CONFLICT',
      );
    }
    if (record.isDefault) await this.clearDefault();
    // MongoDB assigns `_id`, so the id exists only once and only after the write.
    const result = await this.providers.insertOne(structuredClone(record));
    return { _id: result.insertedId, ...record };
  }

  async get(id: string): Promise<StoredModelProviderRecord | undefined> {
    const objectId = toObjectId(id);
    if (!objectId) return undefined;
    return clean(await this.providers.findOne({ _id: objectId }));
  }

  async getByName(name: string): Promise<StoredModelProviderRecord | undefined> {
    return clean(await this.providers.findOne({ name }));
  }

  async getDefault(): Promise<StoredModelProviderRecord | undefined> {
    return clean(await this.providers.findOne({ isDefault: true, enabled: true }));
  }

  async list(options: ModelProviderListOptions = {}): Promise<StoredModelProviderRecord[]> {
    const cursor = options.cursor === undefined ? undefined : toObjectId(options.cursor);
    const filter: Filter<ModelProviderRecord> = {
      ...(options.enabledOnly ? { enabled: true } : {}),
      ...(cursor === undefined ? {} : { _id: { $gt: cursor } }),
    };
    const values = await this.providers
      .find(filter)
      .sort({ _id: 1 })
      .limit(options.limit ?? 100)
      .toArray();
    return values.map((value) => clean(value) as StoredModelProviderRecord);
  }

  /**
   * Applies a patch, then re-validates the whole merged record so a partial
   * update cannot bypass a cross-field invariant or the runtime support gate.
   */
  async update(id: string, patch: unknown): Promise<StoredModelProviderRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const parsedPatch: ModelProviderUpdate = parseModelProviderUpdate(patch);
    // `_id` is not part of the validated shape, so it is set aside and put back.
    const { _id: objectId, ...current } = existing;
    const merged = parseModelProviderRecord({
      ...current,
      ...stripUndefined(parsedPatch),
      updatedAt: nowIso(),
    });
    assertRuntimeSupport(merged);
    if (merged.name !== existing.name) {
      const conflict = await this.getByName(merged.name);
      if (conflict && !conflict._id.equals(objectId)) {
        throw new AgentHarnessError(
          `Model provider name already exists: ${merged.name}`,
          'MODEL_PROVIDER_NAME_CONFLICT',
        );
      }
    }
    if (merged.isDefault) await this.clearDefault(objectId);
    await this.providers.replaceOne({ _id: objectId }, structuredClone(merged));
    return { _id: objectId, ...merged };
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.providers.updateOne(
      { _id: objectId },
      { $set: { enabled, updatedAt: nowIso() } },
    );
    return result.matchedCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.providers.deleteOne({ _id: objectId });
    return result.deletedCount === 1;
  }

  async close(): Promise<void> {
    if (this.options.closeClient) await this.options.client.close();
  }

  /** Keeps at most one default; `exceptId` keeps the incoming default set. */
  private async clearDefault(exceptId?: ObjectId): Promise<void> {
    await this.providers.updateMany(
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

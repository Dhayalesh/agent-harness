import type { Collection, Db, Filter, MongoClient as MongoClientType, WithId } from 'mongodb';
import { MongoClient, ObjectId } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import { PLATFORM_MONGO_APP_NAME } from './model-provider-store.js';
import type { SkillRecord, SkillUpdate } from './skill-definitions.js';
import {
  nowIso,
  parseSkillInput,
  parseSkillRecord,
  parseSkillUpdate,
} from './skill-definitions.js';

export const SKILLS_COLLECTION = 'skills';

export type MongoSkillStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export type SkillListOptions = {
  enabledOnly?: boolean;
  cursor?: string;
  limit?: number;
};

/** A record as stored: the validated fields plus the `_id` MongoDB assigned. */
export type StoredSkillRecord = WithId<SkillRecord>;

/**
 * Store for the records saying where each reusable skill is.
 *
 * The collection holds one flat set of records keyed by `_id` and by `name`. There is
 * no unscoped `find` and no unscoped `updateMany`.
 *
 * A skill is shared: many agents may reference the same record, which is the reason
 * it is a collection of its own rather than an array on each agent. Renaming it or
 * repointing its path therefore reaches every agent using it, and no default record
 * exists because agents name the skills they want.
 *
 * A record says nothing about what the skill does: that is in the document at `uri`,
 * read on every run. It also holds no credential, since the key that reads S3 comes
 * from the environment, so skills are safe to list.
 */
export class MongoSkillStore {
  private readonly database: Db;
  private readonly skills: Collection<SkillRecord>;

  constructor(private readonly options: MongoSkillStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.skills = this.database.collection<SkillRecord>(SKILLS_COLLECTION);
  }

  static async connect(uri: string, databaseName: string): Promise<MongoSkillStore> {
    const client = new MongoClient(uri, { appName: PLATFORM_MONGO_APP_NAME });
    await client.connect();
    return new MongoSkillStore({ client, databaseName, closeClient: true });
  }

  async initialize(): Promise<void> {
    // `_id` needs no index here: MongoDB creates a unique one for it. `name` is
    // unique because it is the handle: two records claiming one name would collide in
    // the registry and in the temporary directory.
    await Promise.all([
      this.skills.createIndex({ name: 1 }, { unique: true }),
      this.skills.createIndex({ enabled: 1 }),
    ]);
  }

  async create(createdBy: string, input: unknown): Promise<StoredSkillRecord> {
    const parsed = parseSkillInput(input);
    const timestamp = nowIso();
    const record = parseSkillRecord({
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy,
    });
    if (await this.getByName(record.name)) {
      throw new AgentHarnessError(
        `Skill name already exists: ${record.name}`,
        'SKILL_NAME_CONFLICT',
      );
    }
    // MongoDB assigns `_id`, so the id exists only once and only after the write.
    const result = await this.skills.insertOne(structuredClone(record));
    return { _id: result.insertedId, ...record };
  }

  async get(id: string): Promise<StoredSkillRecord | undefined> {
    const objectId = toObjectId(id);
    if (!objectId) return undefined;
    return clean(await this.skills.findOne({ _id: objectId }));
  }

  async getByName(name: string): Promise<StoredSkillRecord | undefined> {
    return clean(await this.skills.findOne({ name }));
  }

  async list(options: SkillListOptions = {}): Promise<StoredSkillRecord[]> {
    const cursor = options.cursor === undefined ? undefined : toObjectId(options.cursor);
    const filter: Filter<SkillRecord> = {
      ...(options.enabledOnly ? { enabled: true } : {}),
      ...(cursor === undefined ? {} : { _id: { $gt: cursor } }),
    };
    const values = await this.skills
      .find(filter)
      .sort({ _id: 1 })
      .limit(options.limit ?? 100)
      .toArray();
    return values.map((value) => clean(value) as StoredSkillRecord);
  }

  /**
   * Applies a patch, then re-validates the whole merged record so a partial update
   * cannot bypass a constraint.
   */
  async update(id: string, patch: unknown): Promise<StoredSkillRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const parsedPatch: SkillUpdate = parseSkillUpdate(patch);
    // `_id` is not part of the validated shape, so it is set aside and put back.
    const { _id: objectId, ...current } = existing;
    const merged = parseSkillRecord({
      ...current,
      ...stripUndefined(parsedPatch),
      updatedAt: nowIso(),
    });
    if (merged.name !== existing.name) {
      const conflict = await this.getByName(merged.name);
      if (conflict && !conflict._id.equals(objectId)) {
        throw new AgentHarnessError(
          `Skill name already exists: ${merged.name}`,
          'SKILL_NAME_CONFLICT',
        );
      }
    }
    await this.skills.replaceOne({ _id: objectId }, structuredClone(merged));
    return { _id: objectId, ...merged };
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.skills.updateOne(
      { _id: objectId },
      { $set: { enabled, updatedAt: nowIso() } },
    );
    return result.matchedCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.skills.deleteOne({ _id: objectId });
    return result.deletedCount === 1;
  }

  async close(): Promise<void> {
    if (this.options.closeClient) await this.options.client.close();
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

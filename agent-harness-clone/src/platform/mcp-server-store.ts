import type { Collection, Db, Filter, MongoClient as MongoClientType, WithId } from 'mongodb';
import { MongoClient, ObjectId } from 'mongodb';
import { AgentHarnessError } from '../core/errors.js';
import type { McpServerRecord, McpServerUpdate } from './mcp-server-definitions.js';
import {
  nowIso,
  parseMcpServerInput,
  parseMcpServerRecord,
  parseMcpServerUpdate,
} from './mcp-server-definitions.js';
import { assertMcpRuntimeSupport } from './mcp-server-support.js';
import { PLATFORM_MONGO_APP_NAME } from './model-provider-store.js';

export const MCP_SERVERS_COLLECTION = 'mcp_servers';

export type MongoMcpServerStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export type McpServerListOptions = {
  enabledOnly?: boolean;
  autoConnectOnly?: boolean;
  cursor?: string;
  limit?: number;
};

/** A record as stored: the validated fields plus the `_id` MongoDB assigned. */
export type StoredMcpServerRecord = WithId<McpServerRecord>;

/**
 * Store for MCP server configurations.
 *
 * The collection holds one flat set of records keyed by `_id` and by `name`.
 * There is no unscoped `find` and no unscoped `updateMany`.
 *
 * Records hold the credential in `apiKey`, and a stdio record's `env` can hold
 * more of them, so every read here may return a secret. Do not expose `get`,
 * `getByName`, `listAutoConnect`, or `list` output on an API surface without
 * stripping those fields first.
 *
 * Unlike `model_providers` there is no single default record: MCP servers
 * compose, so `autoConnect` is an independent flag and any number of records may
 * set it.
 */
export class MongoMcpServerStore {
  private readonly database: Db;
  private readonly servers: Collection<McpServerRecord>;

  constructor(private readonly options: MongoMcpServerStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.servers = this.database.collection<McpServerRecord>(MCP_SERVERS_COLLECTION);
  }

  static async connect(uri: string, databaseName: string): Promise<MongoMcpServerStore> {
    const client = new MongoClient(uri, { appName: PLATFORM_MONGO_APP_NAME });
    await client.connect();
    return new MongoMcpServerStore({ client, databaseName, closeClient: true });
  }

  async initialize(): Promise<void> {
    // `_id` needs no index here: MongoDB creates a unique one for it.
    await Promise.all([
      this.servers.createIndex({ name: 1 }, { unique: true }),
      this.servers.createIndex({ enabled: 1, autoConnect: 1 }),
    ]);
  }

  async create(createdBy: string, input: unknown): Promise<StoredMcpServerRecord> {
    const parsed = parseMcpServerInput(input);
    assertMcpRuntimeSupport(parsed);
    const timestamp = nowIso();
    const record = parseMcpServerRecord({
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy,
    });
    if (await this.getByName(record.name)) {
      throw new AgentHarnessError(
        `MCP server name already exists: ${record.name}`,
        'MCP_SERVER_NAME_CONFLICT',
      );
    }
    // MongoDB assigns `_id`, so the id exists only once and only after the write.
    const result = await this.servers.insertOne(structuredClone(record));
    return { _id: result.insertedId, ...record };
  }

  async get(id: string): Promise<StoredMcpServerRecord | undefined> {
    const objectId = toObjectId(id);
    if (!objectId) return undefined;
    return clean(await this.servers.findOne({ _id: objectId }));
  }

  async getByName(name: string): Promise<StoredMcpServerRecord | undefined> {
    return clean(await this.servers.findOne({ name }));
  }

  /**
   * Every record a run picks up. This is the whole selection: the runnable
   * entrypoints read it and nothing else, so no environment variable or local
   * file can add a server or leave one out. The set can be empty, which is not
   * an error: MCP is additive, so a run with no records simply has no MCP tools.
   */
  async listAutoConnect(): Promise<StoredMcpServerRecord[]> {
    return this.list({ enabledOnly: true, autoConnectOnly: true });
  }

  async list(options: McpServerListOptions = {}): Promise<StoredMcpServerRecord[]> {
    const cursor = options.cursor === undefined ? undefined : toObjectId(options.cursor);
    const filter: Filter<McpServerRecord> = {
      ...(options.enabledOnly ? { enabled: true } : {}),
      ...(options.autoConnectOnly ? { autoConnect: true } : {}),
      ...(cursor === undefined ? {} : { _id: { $gt: cursor } }),
    };
    const values = await this.servers
      .find(filter)
      .sort({ _id: 1 })
      .limit(options.limit ?? 100)
      .toArray();
    return values.map((value) => clean(value) as StoredMcpServerRecord);
  }

  /**
   * Applies a patch, then re-validates the whole merged record so a partial
   * update cannot bypass a cross-field invariant or the runtime support gate.
   */
  async update(id: string, patch: unknown): Promise<StoredMcpServerRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const parsedPatch: McpServerUpdate = parseMcpServerUpdate(patch);
    // `_id` is not part of the validated shape, so it is set aside and put back.
    const { _id: objectId, ...current } = existing;
    const merged = parseMcpServerRecord({
      ...current,
      ...stripUndefined(parsedPatch),
      updatedAt: nowIso(),
    });
    assertMcpRuntimeSupport(merged);
    if (merged.name !== existing.name) {
      const conflict = await this.getByName(merged.name);
      if (conflict && !conflict._id.equals(objectId)) {
        throw new AgentHarnessError(
          `MCP server name already exists: ${merged.name}`,
          'MCP_SERVER_NAME_CONFLICT',
        );
      }
    }
    await this.servers.replaceOne({ _id: objectId }, structuredClone(merged));
    return { _id: objectId, ...merged };
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.servers.updateOne(
      { _id: objectId },
      { $set: { enabled, updatedAt: nowIso() } },
    );
    return result.matchedCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const objectId = toObjectId(id);
    if (!objectId) return false;
    const result = await this.servers.deleteOne({ _id: objectId });
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

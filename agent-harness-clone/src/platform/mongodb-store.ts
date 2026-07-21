import type { Collection, Db, Filter, MongoClient as MongoClientType } from 'mongodb';
import { MongoClient } from 'mongodb';
import type {
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  AuditRecord,
  DeploymentRecord,
} from './definitions.js';
import { newId } from './definitions.js';
import type { AgentListOptions, PlatformStore } from './store.js';

export type MongoPlatformStoreOptions = {
  client: MongoClientType;
  databaseName: string;
  closeClient?: boolean;
};

export class MongoPlatformStore implements PlatformStore {
  private readonly database: Db;
  private readonly agents: Collection<AgentRecord>;
  private readonly versions: Collection<AgentVersionRecord>;
  private readonly deployments: Collection<DeploymentRecord>;
  private readonly audits: Collection<AuditRecord>;
  private readonly apiKeys: Collection<ApiKeyRecord>;

  constructor(private readonly options: MongoPlatformStoreOptions) {
    this.database = options.client.db(options.databaseName);
    this.agents = this.database.collection<AgentRecord>('agents');
    this.versions = this.database.collection<AgentVersionRecord>('agent_versions');
    this.deployments = this.database.collection<DeploymentRecord>('agent_deployments');
    this.audits = this.database.collection<AuditRecord>('platform_audit');
    this.apiKeys = this.database.collection<ApiKeyRecord>('platform_api_keys');
  }

  static async connect(uri: string, databaseName: string): Promise<MongoPlatformStore> {
    const client = new MongoClient(uri, { appName: 'trueai-agent-platform' });
    await client.connect();
    return new MongoPlatformStore({ client, databaseName, closeClient: true });
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.agents.createIndex({ tenantId: 1, slug: 1 }, { unique: true }),
      this.agents.createIndex({ tenantId: 1, id: 1 }, { unique: true }),
      this.versions.createIndex({ tenantId: 1, agentId: 1, version: -1 }, { unique: true }),
      this.versions.createIndex({ tenantId: 1, agentId: 1, id: 1 }, { unique: true }),
      this.deployments.createIndex({ tenantId: 1, agentId: 1, environment: 1 }, { unique: true }),
      this.audits.createIndex({ tenantId: 1, resourceId: 1, createdAt: -1 }),
      this.apiKeys.createIndex({ keyHash: 1 }, { unique: true }),
      this.apiKeys.createIndex({ tenantId: 1, id: 1 }, { unique: true }),
    ]);
  }

  async createAgent(agent: AgentRecord): Promise<void> {
    await this.agents.insertOne(structuredClone(agent));
  }

  async getAgent(tenantId: string, idOrSlug: string): Promise<AgentRecord | undefined> {
    const value = await this.agents.findOne({
      tenantId,
      $or: [{ id: idOrSlug }, { slug: idOrSlug }],
    });
    return clean(value);
  }

  async listAgents(tenantId: string, options: AgentListOptions = {}): Promise<AgentRecord[]> {
    const filter: Filter<AgentRecord> = {
      tenantId,
      ...(options.includeArchived ? {} : { archivedAt: { $exists: false } }),
      ...(options.cursor === undefined ? {} : { id: { $gt: options.cursor } }),
    };
    const values = await this.agents
      .find(filter)
      .sort({ id: 1 })
      .limit(options.limit ?? 100)
      .toArray();
    return values.map((value) => clean(value) as AgentRecord);
  }

  async archiveAgent(tenantId: string, agentId: string, archivedAt: string): Promise<boolean> {
    const result = await this.agents.updateOne(
      { tenantId, id: agentId },
      { $set: { archivedAt, updatedAt: archivedAt } },
    );
    return result.matchedCount === 1;
  }

  async allocateAgentVersion(
    tenantId: string,
    agentId: string,
    updatedAt: string,
  ): Promise<number> {
    const agent = await this.agents.findOneAndUpdate(
      { tenantId, id: agentId },
      { $inc: { versionCounter: 1 }, $set: { updatedAt } },
      { returnDocument: 'after' },
    );
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent.versionCounter;
  }

  async insertAgentVersion(version: AgentVersionRecord): Promise<void> {
    await this.versions.insertOne(structuredClone(version));
  }

  async getAgentVersion(
    tenantId: string,
    agentId: string,
    versionIdOrNumber: string | number,
  ): Promise<AgentVersionRecord | undefined> {
    const identity =
      typeof versionIdOrNumber === 'number'
        ? { version: versionIdOrNumber }
        : { id: versionIdOrNumber };
    return clean(await this.versions.findOne({ tenantId, agentId, ...identity }));
  }

  async listAgentVersions(tenantId: string, agentId: string): Promise<AgentVersionRecord[]> {
    const values = await this.versions.find({ tenantId, agentId }).sort({ version: -1 }).toArray();
    return values.map((value) => clean(value) as AgentVersionRecord);
  }

  async setDeployment(input: Omit<DeploymentRecord, 'id' | 'revision'>): Promise<DeploymentRecord> {
    const deployment = await this.deployments.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        agentId: input.agentId,
        environment: input.environment,
      },
      {
        $set: {
          versionId: input.versionId,
          updatedAt: input.updatedAt,
          updatedBy: input.updatedBy,
        },
        $setOnInsert: { id: newId() },
        $inc: { revision: 1 },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!deployment) throw new Error('Failed to update deployment');
    return clean(deployment) as DeploymentRecord;
  }

  async getDeployment(
    tenantId: string,
    agentId: string,
    environment: string,
  ): Promise<DeploymentRecord | undefined> {
    return clean(await this.deployments.findOne({ tenantId, agentId, environment }));
  }

  async listDeployments(tenantId: string, agentId: string): Promise<DeploymentRecord[]> {
    const values = await this.deployments.find({ tenantId, agentId }).toArray();
    return values.map((value) => clean(value) as DeploymentRecord);
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.audits.insertOne(structuredClone(record));
  }

  async listAudit(tenantId: string, resourceId?: string, limit = 100): Promise<AuditRecord[]> {
    const values = await this.audits
      .find({ tenantId, ...(resourceId === undefined ? {} : { resourceId }) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return values.map((value) => clean(value) as AuditRecord);
  }

  async insertApiKey(record: ApiKeyRecord): Promise<void> {
    await this.apiKeys.insertOne(structuredClone(record));
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const values = await this.apiKeys.find({ tenantId }).sort({ createdAt: -1 }).toArray();
    return values.map((value) => clean(value) as ApiKeyRecord);
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    return clean(await this.apiKeys.findOne({ keyHash }));
  }

  async touchApiKey(tenantId: string, id: string, usedAt: string): Promise<void> {
    await this.apiKeys.updateOne({ tenantId, id }, { $set: { lastUsedAt: usedAt } });
  }

  async revokeApiKey(tenantId: string, id: string, revokedAt: string): Promise<boolean> {
    const result = await this.apiKeys.updateOne(
      { tenantId, id, revokedAt: { $exists: false } },
      { $set: { revokedAt } },
    );
    return result.matchedCount === 1;
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

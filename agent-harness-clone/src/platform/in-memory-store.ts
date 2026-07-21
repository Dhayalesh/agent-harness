import type {
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  AuditRecord,
  DeploymentRecord,
} from './definitions.js';
import { newId } from './definitions.js';
import type { AgentListOptions, PlatformStore } from './store.js';

export class InMemoryPlatformStore implements PlatformStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentVersionRecord>();
  private readonly deployments = new Map<string, DeploymentRecord>();
  private readonly audits: AuditRecord[] = [];
  private readonly apiKeys = new Map<string, ApiKeyRecord>();

  async initialize(): Promise<void> {}

  async createAgent(agent: AgentRecord): Promise<void> {
    if (
      [...this.agents.values()].some(
        (item) => item.tenantId === agent.tenantId && item.slug === agent.slug,
      )
    ) {
      throw new Error(`Agent slug already exists: ${agent.slug}`);
    }
    this.agents.set(agent.id, structuredClone(agent));
  }

  async getAgent(tenantId: string, idOrSlug: string): Promise<AgentRecord | undefined> {
    const value = [...this.agents.values()].find(
      (agent) => agent.tenantId === tenantId && (agent.id === idOrSlug || agent.slug === idOrSlug),
    );
    return value ? structuredClone(value) : undefined;
  }

  async listAgents(tenantId: string, options: AgentListOptions = {}): Promise<AgentRecord[]> {
    return [...this.agents.values()]
      .filter(
        (agent) =>
          agent.tenantId === tenantId &&
          (options.includeArchived || agent.archivedAt === undefined) &&
          (options.cursor === undefined || agent.id > options.cursor),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, options.limit ?? 100)
      .map((agent) => structuredClone(agent));
  }

  async archiveAgent(tenantId: string, agentId: string, archivedAt: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.tenantId !== tenantId) return false;
    agent.archivedAt = archivedAt;
    agent.updatedAt = archivedAt;
    return true;
  }

  async allocateAgentVersion(
    tenantId: string,
    agentId: string,
    updatedAt: string,
  ): Promise<number> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.tenantId !== tenantId) throw new Error(`Unknown agent: ${agentId}`);
    agent.versionCounter += 1;
    agent.updatedAt = updatedAt;
    return agent.versionCounter;
  }

  async insertAgentVersion(version: AgentVersionRecord): Promise<void> {
    if (this.versions.has(version.id)) throw new Error(`Version already exists: ${version.id}`);
    if (
      [...this.versions.values()].some(
        (candidate) =>
          candidate.tenantId === version.tenantId &&
          candidate.agentId === version.agentId &&
          candidate.version === version.version,
      )
    ) {
      throw new Error(`Agent version already exists: ${version.version}`);
    }
    this.versions.set(version.id, structuredClone(version));
  }

  async getAgentVersion(
    tenantId: string,
    agentId: string,
    versionIdOrNumber: string | number,
  ): Promise<AgentVersionRecord | undefined> {
    const version = [...this.versions.values()].find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.agentId === agentId &&
        (candidate.id === versionIdOrNumber || candidate.version === versionIdOrNumber),
    );
    return version ? structuredClone(version) : undefined;
  }

  async listAgentVersions(tenantId: string, agentId: string): Promise<AgentVersionRecord[]> {
    return [...this.versions.values()]
      .filter((version) => version.tenantId === tenantId && version.agentId === agentId)
      .sort((left, right) => right.version - left.version)
      .map((version) => structuredClone(version));
  }

  async setDeployment(input: Omit<DeploymentRecord, 'id' | 'revision'>): Promise<DeploymentRecord> {
    const key = `${input.tenantId}:${input.agentId}:${input.environment}`;
    const current = this.deployments.get(key);
    const deployment: DeploymentRecord = {
      ...structuredClone(input),
      id: current?.id ?? newId(),
      revision: (current?.revision ?? 0) + 1,
    };
    this.deployments.set(key, deployment);
    return structuredClone(deployment);
  }

  async getDeployment(
    tenantId: string,
    agentId: string,
    environment: string,
  ): Promise<DeploymentRecord | undefined> {
    const value = this.deployments.get(`${tenantId}:${agentId}:${environment}`);
    return value ? structuredClone(value) : undefined;
  }

  async listDeployments(tenantId: string, agentId: string): Promise<DeploymentRecord[]> {
    return [...this.deployments.values()]
      .filter((deployment) => deployment.tenantId === tenantId && deployment.agentId === agentId)
      .map((deployment) => structuredClone(deployment));
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    this.audits.push(structuredClone(record));
  }

  async listAudit(tenantId: string, resourceId?: string, limit = 100): Promise<AuditRecord[]> {
    return this.audits
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          (resourceId === undefined || record.resourceId === resourceId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async insertApiKey(record: ApiKeyRecord): Promise<void> {
    if ([...this.apiKeys.values()].some((key) => key.keyHash === record.keyHash)) {
      throw new Error('API key hash already exists');
    }
    this.apiKeys.set(record.id, structuredClone(record));
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()]
      .filter((key) => key.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((key) => structuredClone(key));
  }

  async findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const value = [...this.apiKeys.values()].find((key) => key.keyHash === keyHash);
    return value ? structuredClone(value) : undefined;
  }

  async touchApiKey(tenantId: string, id: string, usedAt: string): Promise<void> {
    const key = this.apiKeys.get(id);
    if (key?.tenantId === tenantId) key.lastUsedAt = usedAt;
  }

  async revokeApiKey(tenantId: string, id: string, revokedAt: string): Promise<boolean> {
    const key = this.apiKeys.get(id);
    if (!key || key.tenantId !== tenantId) return false;
    key.revokedAt = revokedAt;
    return true;
  }

  async close(): Promise<void> {}
}

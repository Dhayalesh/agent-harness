import type {
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  AuditRecord,
  DeploymentRecord,
} from './definitions.js';

export type AgentListOptions = {
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
};

export interface PlatformStore {
  initialize(): Promise<void>;

  createAgent(agent: AgentRecord): Promise<void>;
  getAgent(tenantId: string, idOrSlug: string): Promise<AgentRecord | undefined>;
  listAgents(tenantId: string, options?: AgentListOptions): Promise<AgentRecord[]>;
  archiveAgent(tenantId: string, agentId: string, archivedAt: string): Promise<boolean>;
  allocateAgentVersion(tenantId: string, agentId: string, updatedAt: string): Promise<number>;

  insertAgentVersion(version: AgentVersionRecord): Promise<void>;
  getAgentVersion(
    tenantId: string,
    agentId: string,
    versionIdOrNumber: string | number,
  ): Promise<AgentVersionRecord | undefined>;
  listAgentVersions(tenantId: string, agentId: string): Promise<AgentVersionRecord[]>;

  setDeployment(input: Omit<DeploymentRecord, 'id' | 'revision'>): Promise<DeploymentRecord>;
  getDeployment(
    tenantId: string,
    agentId: string,
    environment: string,
  ): Promise<DeploymentRecord | undefined>;
  listDeployments(tenantId: string, agentId: string): Promise<DeploymentRecord[]>;

  appendAudit(record: AuditRecord): Promise<void>;
  listAudit(tenantId: string, resourceId?: string, limit?: number): Promise<AuditRecord[]>;

  insertApiKey(record: ApiKeyRecord): Promise<void>;
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;
  findApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  touchApiKey(tenantId: string, id: string, usedAt: string): Promise<void>;
  revokeApiKey(tenantId: string, id: string, revokedAt: string): Promise<boolean>;

  close(): Promise<void>;
}

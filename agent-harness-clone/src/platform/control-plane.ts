import { createHash, randomBytes } from 'node:crypto';
import type {
  AgentDefinition,
  AgentRecord,
  AgentVersionRecord,
  ApiKeyRecord,
  AuditRecord,
  DeploymentRecord,
  PlatformPrincipal,
  PlatformRole,
} from './definitions.js';
import { definitionChecksum, newId, nowIso, parseAgentDefinition } from './definitions.js';
import type { PlatformStore } from './store.js';

export class AgentPlatformControlPlane {
  constructor(private readonly store: PlatformStore) {}

  initialize(): Promise<void> {
    return this.store.initialize();
  }

  async createAgent(
    principal: PlatformPrincipal,
    input: { slug: string; name: string; description?: string },
  ): Promise<AgentRecord> {
    requireRole(principal, 'editor');
    if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.slug)) {
      throw new Error('Agent slug must contain lowercase letters, numbers, and hyphens');
    }
    const now = nowIso();
    const agent: AgentRecord = {
      id: newId(),
      tenantId: principal.tenantId,
      slug: input.slug,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      versionCounter: 0,
      createdAt: now,
      createdBy: principal.userId,
      updatedAt: now,
    };
    if (!agent.name) throw new Error('Agent name is required');
    await this.store.createAgent(agent);
    await this.audit(principal, 'agent.created', 'agent', agent.id, { slug: agent.slug });
    return structuredClone(agent);
  }

  async createVersion(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    definitionValue: unknown,
  ): Promise<AgentVersionRecord> {
    requireRole(principal, 'editor');
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    if (agent.archivedAt) throw new Error('Cannot version an archived agent');
    const definition = parseAgentDefinition(definitionValue);
    if (
      (definition.permissions.mode === 'bypass' || definition.mcpServers.length > 0) &&
      !principal.roles.includes('admin')
    ) {
      throw new Error('Admin role is required for bypass mode or MCP server configuration');
    }
    const createdAt = nowIso();
    const versionNumber = await this.store.allocateAgentVersion(
      principal.tenantId,
      agent.id,
      createdAt,
    );
    const version: AgentVersionRecord = {
      id: newId(),
      tenantId: principal.tenantId,
      agentId: agent.id,
      version: versionNumber,
      definition,
      checksum: definitionChecksum(definition),
      createdAt,
      createdBy: principal.userId,
    };
    await this.store.insertAgentVersion(version);
    await this.audit(principal, 'agent.version.created', 'agent', agent.id, {
      versionId: version.id,
      version: version.version,
      checksum: version.checksum,
    });
    return structuredClone(version);
  }

  async getAgent(principal: PlatformPrincipal, idOrSlug: string): Promise<AgentRecord> {
    requireAnyRole(principal, ['viewer', 'editor', 'executor']);
    return this.requireAgent(principal.tenantId, idOrSlug);
  }

  async listAgents(principal: PlatformPrincipal): Promise<AgentRecord[]> {
    requireAnyRole(principal, ['viewer', 'editor', 'executor']);
    return this.store.listAgents(principal.tenantId);
  }

  async listVersions(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
  ): Promise<AgentVersionRecord[]> {
    requireAnyRole(principal, ['viewer', 'editor', 'executor']);
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    return this.store.listAgentVersions(principal.tenantId, agent.id);
  }

  async archiveAgent(principal: PlatformPrincipal, agentIdOrSlug: string): Promise<void> {
    requireRole(principal, 'editor');
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    const archivedAt = nowIso();
    if (!(await this.store.archiveAgent(principal.tenantId, agent.id, archivedAt))) {
      throw new Error(`Unknown agent: ${agentIdOrSlug}`);
    }
    await this.audit(principal, 'agent.archived', 'agent', agent.id, { archivedAt });
  }

  async publish(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    versionIdOrNumber: string | number,
    environment = 'production',
  ): Promise<DeploymentRecord> {
    requireRole(principal, 'editor');
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    if (agent.archivedAt) throw new Error('Cannot deploy an archived agent');
    const version = await this.requireVersion(principal.tenantId, agent.id, versionIdOrNumber);
    const deployment = await this.store.setDeployment({
      tenantId: principal.tenantId,
      agentId: agent.id,
      environment: validateEnvironment(environment),
      versionId: version.id,
      updatedAt: nowIso(),
      updatedBy: principal.userId,
    });
    await this.audit(principal, 'agent.deployed', 'agent', agent.id, {
      environment: deployment.environment,
      deploymentRevision: deployment.revision,
      versionId: version.id,
      version: version.version,
    });
    return deployment;
  }

  async rollback(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    targetVersionIdOrNumber: string | number,
    environment = 'production',
  ): Promise<DeploymentRecord> {
    requireRole(principal, 'editor');
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    if (agent.archivedAt) throw new Error('Cannot deploy an archived agent');
    const previous = await this.store.getDeployment(
      principal.tenantId,
      agent.id,
      validateEnvironment(environment),
    );
    if (!previous) throw new Error(`No deployment exists for ${environment}`);
    const target = await this.requireVersion(principal.tenantId, agent.id, targetVersionIdOrNumber);
    const deployment = await this.store.setDeployment({
      tenantId: principal.tenantId,
      agentId: agent.id,
      environment: previous.environment,
      versionId: target.id,
      updatedAt: nowIso(),
      updatedBy: principal.userId,
    });
    await this.audit(principal, 'agent.deployment.rolled_back', 'agent', agent.id, {
      environment: deployment.environment,
      fromVersionId: previous.versionId,
      toVersionId: target.id,
      deploymentRevision: deployment.revision,
    });
    return deployment;
  }

  async listDeployments(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
  ): Promise<DeploymentRecord[]> {
    requireAnyRole(principal, ['viewer', 'editor', 'executor']);
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    return this.store.listDeployments(principal.tenantId, agent.id);
  }

  async resolveDeployment(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment = 'production',
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord; deployment: DeploymentRecord }> {
    requireRole(principal, 'executor');
    const agent = await this.requireAgent(principal.tenantId, agentIdOrSlug);
    if (agent.archivedAt) throw new Error('Cannot execute an archived agent');
    const deployment = await this.store.getDeployment(
      principal.tenantId,
      agent.id,
      validateEnvironment(environment),
    );
    if (!deployment) throw new Error(`Agent is not deployed to ${environment}`);
    const version = await this.requireVersion(principal.tenantId, agent.id, deployment.versionId);
    return { agent, version, deployment };
  }

  async createApiKey(
    principal: PlatformPrincipal,
    name: string,
    roles: PlatformRole[],
  ): Promise<{ record: Omit<ApiKeyRecord, 'keyHash'>; secret: string }> {
    requireRole(principal, 'admin');
    if (!name.trim()) throw new Error('API key name is required');
    if (!roles.length) throw new Error('API key requires at least one role');
    const secret = `ahp_${randomBytes(32).toString('base64url')}`;
    const record: ApiKeyRecord = {
      id: newId(),
      tenantId: principal.tenantId,
      name: name.trim(),
      keyHash: hashApiKey(secret),
      roles: [...new Set(roles)],
      createdAt: nowIso(),
      createdBy: principal.userId,
    };
    await this.store.insertApiKey(record);
    await this.audit(principal, 'api_key.created', 'api_key', record.id, {
      name: record.name,
      roles: record.roles,
    });
    const { keyHash: _keyHash, ...publicRecord } = record;
    return { record: structuredClone(publicRecord), secret };
  }

  async authenticateApiKey(secret: string): Promise<PlatformPrincipal | undefined> {
    const key = await this.store.findApiKeyByHash(hashApiKey(secret));
    if (!key || key.revokedAt) return undefined;
    await this.store.touchApiKey(key.tenantId, key.id, nowIso());
    return { tenantId: key.tenantId, userId: `api-key:${key.id}`, roles: key.roles };
  }

  async listApiKeys(principal: PlatformPrincipal): Promise<Array<Omit<ApiKeyRecord, 'keyHash'>>> {
    requireRole(principal, 'admin');
    return (await this.store.listApiKeys(principal.tenantId)).map(
      ({ keyHash: _keyHash, ...record }) => record,
    );
  }

  async revokeApiKey(principal: PlatformPrincipal, apiKeyId: string): Promise<void> {
    requireRole(principal, 'admin');
    const revokedAt = nowIso();
    if (!(await this.store.revokeApiKey(principal.tenantId, apiKeyId, revokedAt))) {
      throw new Error(`Unknown API key: ${apiKeyId}`);
    }
    await this.audit(principal, 'api_key.revoked', 'api_key', apiKeyId, { revokedAt });
  }

  listAudit(
    principal: PlatformPrincipal,
    resourceId?: string,
    limit?: number,
  ): Promise<AuditRecord[]> {
    requireRole(principal, 'admin');
    return this.store.listAudit(principal.tenantId, resourceId, limit);
  }

  private requireAgent(tenantId: string, idOrSlug: string): Promise<AgentRecord> {
    return requireFound(this.store.getAgent(tenantId, idOrSlug), `Unknown agent: ${idOrSlug}`);
  }

  private requireVersion(
    tenantId: string,
    agentId: string,
    idOrNumber: string | number,
  ): Promise<AgentVersionRecord> {
    return requireFound(
      this.store.getAgentVersion(tenantId, agentId, idOrNumber),
      `Unknown agent version: ${String(idOrNumber)}`,
    );
  }

  private audit(
    principal: PlatformPrincipal,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const record: AuditRecord = {
      id: newId(),
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action,
      resourceType,
      resourceId,
      createdAt: nowIso(),
      details: structuredClone(details),
    };
    return this.store.appendAudit(record);
  }
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function requireRole(principal: PlatformPrincipal, role: PlatformRole): void {
  if (principal.roles.includes('admin') || principal.roles.includes(role)) return;
  throw new Error(`Role required: ${role}`);
}

function requireAnyRole(principal: PlatformPrincipal, roles: PlatformRole[]): void {
  if (principal.roles.includes('admin') || roles.some((role) => principal.roles.includes(role))) {
    return;
  }
  throw new Error(`One role required: ${roles.join(', ')}`);
}

async function requireFound<T>(promise: Promise<T | undefined>, message: string): Promise<T> {
  const value = await promise;
  if (!value) throw new Error(message);
  return value;
}

function validateEnvironment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)) {
    throw new Error('Invalid deployment environment');
  }
  return value;
}

export type { AgentDefinition };

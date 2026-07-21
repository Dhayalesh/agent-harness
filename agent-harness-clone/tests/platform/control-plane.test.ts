import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentPlatformControlPlane,
  InMemoryPlatformStore,
  type AgentDefinition,
  type PlatformPrincipal,
} from '../../src/index.js';

const admin: PlatformPrincipal = {
  tenantId: 'tenant-a',
  userId: 'admin-a',
  roles: ['admin'],
};

const definition: AgentDefinition = {
  systemPrompt: 'You are a database-configured coding agent.',
  model: {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    secretRef: 'OPENROUTER_API_KEY',
  },
  tools: [{ name: 'read_file', version: '1' }],
  skills: [
    {
      name: 'review',
      version: '1',
      description: 'Review code',
      instructions: 'Inspect the relevant code and report concrete findings.',
      allowedTools: ['read_file'],
    },
  ],
  dataSources: [],
  mcpServers: [],
  permissions: { mode: 'default', fallback: 'ask', rules: [] },
  limits: { maxTurns: 20, maxTotalTokens: 50_000 },
  metadata: { ownerTeam: 'platform' },
};

test('control plane versions, publishes, resolves, and rolls back immutable agents', async () => {
  const store = new InMemoryPlatformStore();
  const control = new AgentPlatformControlPlane(store);
  await control.initialize();
  const agent = await control.createAgent(admin, {
    slug: 'code-reviewer',
    name: 'Code Reviewer',
  });
  const first = await control.createVersion(admin, agent.id, definition);
  const second = await control.createVersion(admin, agent.slug, {
    ...definition,
    systemPrompt: 'You are the second immutable version.',
  });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.notEqual(first.checksum, second.checksum);

  const deployed = await control.publish(admin, agent.id, second.id, 'production');
  assert.equal(deployed.revision, 1);
  assert.equal((await control.resolveDeployment(admin, agent.slug)).version.id, second.id);

  const rolledBack = await control.rollback(admin, agent.id, first.version, 'production');
  assert.equal(rolledBack.revision, 2);
  assert.equal((await control.resolveDeployment(admin, agent.id)).version.id, first.id);

  const versions = await control.listVersions(admin, agent.id);
  assert.deepEqual(
    versions.map((version) => version.version),
    [2, 1],
  );
  const audit = await control.listAudit(admin, agent.id);
  assert.ok(audit.some((record) => record.action === 'agent.deployment.rolled_back'));
});

test('agent definitions reject unavailable skill tool references', async () => {
  const control = new AgentPlatformControlPlane(new InMemoryPlatformStore());
  const agent = await control.createAgent(admin, { slug: 'invalid-agent', name: 'Invalid' });
  await assert.rejects(
    control.createVersion(admin, agent.id, {
      ...definition,
      skills: [{ ...definition.skills[0], allowedTools: ['bash'] }],
    }),
    /references unavailable tool bash/,
  );
});

test('tenant boundaries and API-key roles are enforced', async () => {
  const store = new InMemoryPlatformStore();
  const control = new AgentPlatformControlPlane(store);
  const agent = await control.createAgent(admin, { slug: 'private-agent', name: 'Private' });
  const otherTenant: PlatformPrincipal = {
    tenantId: 'tenant-b',
    userId: 'viewer-b',
    roles: ['viewer'],
  };
  await assert.rejects(control.getAgent(otherTenant, agent.id), /Unknown agent/);

  const issued = await control.createApiKey(admin, 'execution key', ['executor']);
  assert.ok(issued.secret.startsWith('ahp_'));
  assert.equal('keyHash' in issued.record, false);
  const listedKeys = await control.listApiKeys(admin);
  assert.equal(listedKeys[0]?.id, issued.record.id);
  assert.equal('keyHash' in (listedKeys[0] ?? {}), false);
  const authenticated = await control.authenticateApiKey(issued.secret);
  assert.deepEqual(authenticated?.roles, ['executor']);
  await control.revokeApiKey(admin, issued.record.id);
  assert.equal(await control.authenticateApiKey(issued.secret), undefined);
});

test('privileged definitions and execution require the correct roles', async () => {
  const control = new AgentPlatformControlPlane(new InMemoryPlatformStore());
  const agent = await control.createAgent(admin, { slug: 'guarded-agent', name: 'Guarded' });
  const editor: PlatformPrincipal = {
    tenantId: admin.tenantId,
    userId: 'editor-a',
    roles: ['editor'],
  };
  await assert.rejects(
    control.createVersion(editor, agent.id, {
      ...definition,
      permissions: { ...definition.permissions, mode: 'bypass' },
    }),
    /Admin role is required/,
  );
  await assert.rejects(
    control.createVersion(editor, agent.id, {
      ...definition,
      mcpServers: [
        {
          name: 'approved-mcp',
          version: '1',
          transport: 'stdio',
          command: 'approved-mcp',
        },
      ],
    }),
    /Admin role is required/,
  );
  const version = await control.createVersion(admin, agent.id, definition);
  await control.publish(admin, agent.id, version.id);
  await assert.rejects(
    control.resolveDeployment(
      { tenantId: admin.tenantId, userId: 'viewer-a', roles: ['viewer'] },
      agent.id,
    ),
    /Role required: executor/,
  );
});

test('archived agents cannot be versioned, deployed, rolled back, or executed', async () => {
  const control = new AgentPlatformControlPlane(new InMemoryPlatformStore());
  const agent = await control.createAgent(admin, { slug: 'archived-agent', name: 'Archived' });
  const first = await control.createVersion(admin, agent.id, definition);
  const second = await control.createVersion(admin, agent.id, {
    ...definition,
    systemPrompt: 'Second version.',
  });
  await control.publish(admin, agent.id, first.id);
  await control.archiveAgent(admin, agent.id);
  await assert.rejects(control.createVersion(admin, agent.id, definition), /Cannot version/);
  await assert.rejects(control.publish(admin, agent.id, second.id), /Cannot deploy/);
  await assert.rejects(control.rollback(admin, agent.id, second.id), /Cannot deploy/);
  await assert.rejects(control.resolveDeployment(admin, agent.id), /Cannot execute/);
});

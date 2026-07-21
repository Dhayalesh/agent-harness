import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import {
  AgentPlatformControlPlane,
  MongoPlatformRuntimeStore,
  MongoPlatformStore,
  type AgentDefinition,
  type PlatformPrincipal,
} from '../../src/index.js';

test(
  'optional MongoDB integration persists control-plane and runtime records',
  { skip: !process.env.AGENT_HARNESS_MONGODB_TEST_URI },
  async () => {
    const client = new MongoClient(process.env.AGENT_HARNESS_MONGODB_TEST_URI as string);
    const databaseName = `agent_harness_test_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    const store = new MongoPlatformStore({ client, databaseName });
    const runtime = new MongoPlatformRuntimeStore({ client, databaseName });
    const control = new AgentPlatformControlPlane(store);
    const principal: PlatformPrincipal = {
      tenantId: 'mongo-tenant',
      userId: 'mongo-admin',
      roles: ['admin'],
    };
    const definition: AgentDefinition = {
      systemPrompt: 'MongoDB integration test.',
      model: { provider: 'openrouter', model: 'test/model', secretRef: 'MODEL_KEY' },
      tools: [],
      skills: [],
      dataSources: [],
      mcpServers: [],
      permissions: { mode: 'default', fallback: 'deny', rules: [] },
      limits: { maxTurns: 2 },
      metadata: {},
    };
    try {
      await Promise.all([control.initialize(), runtime.initialize()]);
      const agent = await control.createAgent(principal, { slug: 'mongo-agent', name: 'Mongo' });
      const version = await control.createVersion(principal, agent.id, definition);
      await control.publish(principal, agent.id, version.id);
      assert.equal((await control.resolveDeployment(principal, agent.id)).version.id, version.id);
      await runtime.createSession({
        sessionId: 'mongo-session',
        tenantId: principal.tenantId,
        ownerId: principal.userId,
        agentIdOrSlug: agent.id,
        environment: 'production',
        controlTokenHash: 'hash',
        status: 'open',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      assert.equal(
        (await runtime.getSession(principal.tenantId, 'mongo-session'))?.ownerId,
        principal.userId,
      );
    } finally {
      await client.db(databaseName).dropDatabase();
      await client.close();
    }
  },
);

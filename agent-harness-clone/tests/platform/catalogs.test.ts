import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db } from 'mongodb';
import {
  EnvironmentPlatformSecretResolver,
  InMemoryPlatformSecretResolver,
  MongoCollectionDataSourceConnector,
  type DataSourceBinding,
} from '../../src/index.js';

test('environment secrets are tenant-scoped unless global fallback is explicitly enabled', async () => {
  const tenantName = 'PLATFORM_TEST_SECRET_TENANT_A__MODEL_KEY';
  const globalName = 'PLATFORM_TEST_SECRET_MODEL_KEY';
  const previousTenant = process.env[tenantName];
  const previousGlobal = process.env[globalName];
  process.env[tenantName] = 'tenant-value';
  process.env[globalName] = 'global-value';
  try {
    const isolated = new EnvironmentPlatformSecretResolver('PLATFORM_TEST_SECRET_');
    assert.equal(await isolated.get('tenant-a', 'MODEL_KEY'), 'tenant-value');
    assert.equal(await isolated.get('tenant-b', 'MODEL_KEY'), undefined);
    const fallback = new EnvironmentPlatformSecretResolver('PLATFORM_TEST_SECRET_', true);
    assert.equal(await fallback.get('tenant-b', 'MODEL_KEY'), 'global-value');
    await assert.rejects(isolated.get('tenant-a', '../MODEL_KEY'), /Invalid secret reference/);
  } finally {
    restoreEnvironment(tenantName, previousTenant);
    restoreEnvironment(globalName, previousGlobal);
  }
});

test('in-memory secrets do not leak across tenants', async () => {
  const secrets = new InMemoryPlatformSecretResolver({
    'tenant-a': { MODEL_KEY: 'tenant-a-value' },
  });
  assert.equal(await secrets.get('tenant-a', 'MODEL_KEY'), 'tenant-a-value');
  assert.equal(await secrets.get('tenant-b', 'MODEL_KEY'), undefined);
});

test('MongoDB data-source filters reject operator and dotted-key injection before querying', async () => {
  let queried = false;
  const database = {
    collection() {
      queried = true;
      throw new Error('query should not be reached');
    },
  } as unknown as Db;
  const connector = new MongoCollectionDataSourceConnector(database);
  const binding: DataSourceBinding = {
    name: 'unsafe',
    type: 'mongodb-collection',
    version: '1',
    config: {
      collection: 'knowledge',
      filter: { $where: 'malicious()' },
    },
  };
  await assert.rejects(
    connector.retrieve(binding, {
      principal: { tenantId: 'tenant-a', userId: 'executor', roles: ['executor'] },
      agentId: 'agent',
      prompt: 'query',
      signal: new AbortController().signal,
      secrets: new InMemoryPlatformSecretResolver({}),
    }),
    /unsafe key: \$where/,
  );
  assert.equal(queried, false);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

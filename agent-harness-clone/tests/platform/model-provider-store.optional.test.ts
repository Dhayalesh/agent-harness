import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MODEL_PROVIDERS_COLLECTION, MongoModelProviderStore } from '../../src/index.js';

const capabilities = {
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: false,
  reportsCost: false,
};

const input = {
  name: 'primary',
  provider: 'openai-compatible' as const,
  model: 'zai.glm-5',
  baseURL: 'https://models.internal.example/v1',
  apiKey: 'test-key',
  auth: { kind: 'bearer' as const },
  capabilities,
  enabled: true,
};

test(
  'optional MongoDB integration: model_providers indexes and CRUD',
  // Runs against PLATFORM_MONGODB_URI when set, in a throwaway database of its
  // own, so no separate test connection string is needed.
  { skip: !process.env.PLATFORM_MONGODB_URI },
  async () => {
    const client = new MongoClient(process.env.PLATFORM_MONGODB_URI as string);
    const databaseName = `agent_harness_test_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    const store = new MongoModelProviderStore({ client, databaseName });
    try {
      await store.initialize();

      const indexes = await client
        .db(databaseName)
        .collection(MODEL_PROVIDERS_COLLECTION)
        .indexes();
      const keys = indexes.map((index) => JSON.stringify(index.key));
      // MongoDB's own unique index on `_id` is the record's identity index.
      assert.ok(keys.includes(JSON.stringify({ _id: 1 })));
      assert.ok(keys.includes(JSON.stringify({ name: 1 })));
      assert.ok(keys.includes(JSON.stringify({ enabled: 1 })));
      assert.equal(
        indexes.find((index) => JSON.stringify(index.key) === JSON.stringify({ name: 1 }))?.unique,
        true,
      );

      const created = await store.create('operator', { ...input, isDefault: true });
      assert.equal(created.isDefault, true);
      // MongoDB assigned the id, and its hex form is what the methods accept.
      const createdId = created._id.toHexString();

      assert.equal((await store.get(createdId))?.name, 'primary');
      assert.equal((await store.getByName('primary'))?._id.toHexString(), createdId);
      assert.equal((await store.getDefault())?._id.toHexString(), createdId);
      assert.equal((await store.list()).length, 1);

      // Reads for an unknown record return nothing, for every read path.
      assert.equal(await store.get(new ObjectId().toHexString()), undefined);
      assert.equal(await store.getByName('absent'), undefined);

      // An id that is not an ObjectId reads as absent rather than throwing.
      assert.equal(await store.get(randomUUID()), undefined);
      assert.equal(await store.setEnabled(randomUUID(), false), false);
      assert.equal(await store.delete(randomUUID()), false);

      // Writes against an unknown id must not touch the stored record.
      const unknownId = new ObjectId().toHexString();
      assert.equal(await store.setEnabled(unknownId, false), false);
      assert.equal(await store.update(unknownId, { model: 'hijacked' }), undefined);
      assert.equal(await store.delete(unknownId), false);
      assert.equal((await store.get(createdId))?.model, 'zai.glm-5');
      assert.equal((await store.get(createdId))?.enabled, true);

      // Names are unique across the collection.
      await assert.rejects(store.create('operator', input), {
        code: 'MODEL_PROVIDER_NAME_CONFLICT',
      });

      // Write-time capability gate, through the store.
      await assert.rejects(
        store.create('operator', {
          ...input,
          name: 'bedrock-one',
          provider: 'bedrock',
        }),
        { code: 'UNSUPPORTED_MODEL_PROVIDER' },
      );
      await assert.rejects(
        store.create('operator', {
          ...input,
          name: 'no-auth',
          apiKey: undefined,
          auth: { kind: 'none' },
        }),
        { code: 'UNSUPPORTED_MODEL_AUTH_KIND' },
      );
      await assert.rejects(
        store.create('operator', {
          ...input,
          name: 'reasoning',
          wire: { reasoningField: 'reasoning_content' },
        }),
        { code: 'UNSUPPORTED_MODEL_WIRE_FIELD' },
      );

      // At most one default in the collection.
      const second = await store.create('operator', {
        ...input,
        name: 'secondary',
        isDefault: true,
      });
      const secondId = second._id.toHexString();
      assert.equal((await store.getDefault())?._id.toHexString(), secondId);
      assert.equal((await store.get(createdId))?.isDefault, false);

      // A patch is re-validated against the gate on the merged record.
      await assert.rejects(store.update(secondId, { provider: 'bedrock' }), {
        code: 'UNSUPPORTED_MODEL_PROVIDER',
      });
      const updated = await store.update(secondId, { model: 'zai.glm-5-air' });
      assert.equal(updated?.model, 'zai.glm-5-air');
      assert.equal(updated?.createdAt, second.createdAt);
      assert.equal(updated?._id.toHexString(), secondId);

      assert.equal(await store.setEnabled(secondId, false), true);
      assert.equal((await store.get(secondId))?.enabled, false);
      assert.equal(await store.getDefault(), undefined);
      assert.equal((await store.list({ enabledOnly: true })).length, 1);

      assert.equal(await store.delete(secondId), true);
      assert.equal(await store.get(secondId), undefined);
      assert.equal((await store.list()).length, 1);
    } finally {
      await client.db(databaseName).dropDatabase();
      await client.close();
    }
  },
);

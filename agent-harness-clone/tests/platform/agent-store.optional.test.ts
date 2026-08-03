import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { AGENTS_COLLECTION, MongoAgentStore } from '../../src/index.js';

/** The `_id`s an agent's reference fields point at. */
const PROVIDER_ID = '6a67cb6e3c57852f5710071d';
const MCP_SERVER_ID = '6a67cb6e3c57852f5710071e';

const SKILL_ID = '6a67cb6e3c57852f57100720';
const SYSTEM_PROMPT = 'You review code.';

const input = {
  name: 'reviewer',
  description: 'Reviews changes without editing them',
  systemPrompt: SYSTEM_PROMPT,
  modelProviderId: PROVIDER_ID,
  tools: ['read_file', 'grep'],
  skills: [{ skillId: SKILL_ID, allowedTools: ['read_file'] }],
  mcpServerIds: [MCP_SERVER_ID],
  limits: { maxTurns: 8 },
  enabled: true,
};

test(
  'optional MongoDB integration: agents indexes and CRUD',
  // Runs against PLATFORM_MONGODB_URI when set, in a throwaway database of its
  // own, so no separate test connection string is needed.
  { skip: !process.env.PLATFORM_MONGODB_URI },
  async () => {
    const client = new MongoClient(process.env.PLATFORM_MONGODB_URI as string);
    const databaseName = `agent_harness_test_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    const store = new MongoAgentStore({ client, databaseName });
    try {
      await store.initialize();

      const indexes = await client.db(databaseName).collection(AGENTS_COLLECTION).indexes();
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
      // References are stored as written and not followed: the store never reads
      // the other two collections, so an agent can be written before them and a
      // dangling reference surfaces at resolution instead of at write time.
      assert.equal(created.modelProviderId, PROVIDER_ID);
      assert.deepEqual(created.mcpServerIds, [MCP_SERVER_ID]);
      assert.deepEqual(created.skills, [{ skillId: SKILL_ID, allowedTools: ['read_file'] }]);
      // The prompt is stored here; the skill body is not, which is what keeps the
      // document bounded however long a skill grows.
      assert.equal(created.systemPrompt, SYSTEM_PROMPT);
      // MongoDB assigned the id, and its hex form is what the methods accept.
      const createdId = created._id.toHexString();

      assert.equal((await store.get(createdId))?.name, 'reviewer');
      assert.equal((await store.getByName('reviewer'))?._id.toHexString(), createdId);
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
      assert.equal(await store.update(unknownId, { systemPrompt: 'hijacked' }), undefined);
      assert.equal(await store.delete(unknownId), false);
      assert.equal((await store.get(createdId))?.systemPrompt, SYSTEM_PROMPT);
      assert.equal((await store.get(createdId))?.enabled, true);

      // Names are unique across the collection.
      await assert.rejects(store.create('operator', input), { code: 'AGENT_NAME_CONFLICT' });

      // Write-time support gate, through the store.
      await assert.rejects(
        store.create('operator', {
          ...input,
          name: 'misspelled',
          skills: [],
          tools: ['read_files'],
        }),
        { code: 'UNSUPPORTED_AGENT_TOOL' },
      );
      await assert.rejects(
        store.create('operator', {
          ...input,
          name: 'remote',
          skills: [],
          tools: ['mcp__files__read'],
        }),
        { code: 'UNSUPPORTED_AGENT_TOOL' },
      );

      // At most one default in the collection.
      const second = await store.create('operator', {
        ...input,
        name: 'editor',
        isDefault: true,
      });
      const secondId = second._id.toHexString();
      assert.equal((await store.getDefault())?._id.toHexString(), secondId);
      assert.equal((await store.get(createdId))?.isDefault, false);

      // A patch is re-validated against the gate on the merged record, and the
      // cross-field invariants are re-checked there too rather than on the patch.
      await assert.rejects(store.update(secondId, { tools: ['read_files'], skills: [] }), {
        code: 'UNSUPPORTED_AGENT_TOOL',
      });
      // Dropping `read_file` would leave the stored skill allowing a tool the
      // agent no longer has.
      await assert.rejects(store.update(secondId, { tools: ['grep'] }));

      const updated = await store.update(secondId, {
        tools: ['read_file', 'grep', 'edit_file'],
        limits: { maxTurns: 16, maxOutputTokens: 2_048 },
      });
      assert.deepEqual(updated?.tools, ['read_file', 'grep', 'edit_file']);
      assert.deepEqual(updated?.limits, { maxTurns: 16, maxOutputTokens: 2_048 });
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

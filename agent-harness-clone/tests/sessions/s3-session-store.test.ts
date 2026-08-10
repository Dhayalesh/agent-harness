import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySessionStore } from '../../src/sessions/session-store.js';
import { S3SessionStore } from '../../src/sessions/s3-session-store.js';
import { TieredSessionStore } from '../../src/sessions/tiered-session-store.js';

type SentCommand = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

function fakeS3(handler: (command: SentCommand) => unknown | Promise<unknown>) {
  const commands: SentCommand[] = [];
  const client = {
    send(command: SentCommand) {
      commands.push(command);
      return Promise.resolve().then(() => handler(command));
    },
  };
  return { client, commands };
}

function stored(id = 'sap-session') {
  return {
    version: 1 as const,
    id,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T01:00:00.000Z',
    messages: [],
    metadata: { agentName: 'sap-agent' },
  };
}

function body(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    async transformToByteArray(): Promise<Uint8Array> {
      return bytes;
    },
  };
}

function awsError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

test('loads a durable session and uses its ETag for the next conditional write', async () => {
  const session = stored();
  const fake = fakeS3((command) =>
    command.constructor.name === 'GetObjectCommand'
      ? {
          ETag: '"revision-4"',
          ContentLength: Buffer.byteLength(JSON.stringify(session)),
          Body: body(session),
        }
      : { ETag: '"revision-5"' },
  );
  const store = new S3SessionStore({
    bucket: 'sap-agent-sessions',
    prefix: 'production/sessions',
    client: fake.client as never,
  });

  assert.deepEqual(await store.load(session.id), session);
  await store.save({ ...session, updatedAt: '2026-08-11T02:00:00.000Z' });

  assert.equal(fake.commands[0]?.constructor.name, 'GetObjectCommand');
  assert.deepEqual(fake.commands[0]?.input, {
    Bucket: 'sap-agent-sessions',
    Key: 'production/sessions/sap-session.json',
  });
  const put = fake.commands[1];
  assert.equal(put?.constructor.name, 'PutObjectCommand');
  assert.equal(put?.input.IfMatch, '"revision-4"');
  assert.equal(put?.input.IfNoneMatch, undefined);
  assert.equal(put?.input.ServerSideEncryption, 'AES256');
  assert.equal(put?.input.SSEKMSKeyId, undefined);
});

test('creates a missing session with If-None-Match and rejects a competing writer', async () => {
  let conflict = false;
  const fake = fakeS3((command) => {
    if (command.constructor.name === 'GetObjectCommand') {
      throw awsError('NoSuchKey', 404);
    }
    if (conflict) throw awsError('PreconditionFailed', 412);
    return { ETag: '"revision-1"' };
  });
  const store = new S3SessionStore({
    bucket: 'sap-agent-sessions',
    client: fake.client as never,
  });

  assert.equal(await store.load('new-session'), undefined);
  await store.save(stored('new-session'));
  assert.equal(fake.commands[1]?.input.IfNoneMatch, '*');
  assert.equal(fake.commands[1]?.input.ServerSideEncryption, 'AES256');

  conflict = true;
  await assert.rejects(store.save(stored('new-session')), {
    code: 'SESSION_CONFLICT',
    recoverable: true,
  });
});

test('reports malformed, oversized, and unavailable S3 sessions distinctly', async () => {
  const malformed = fakeS3(() => ({ ETag: '"bad"', Body: body({ version: 99 }) }));
  await assert.rejects(
    new S3SessionStore({ bucket: 'bucket', client: malformed.client as never }).load('bad'),
    { code: 'INVALID_STORED_SESSION', recoverable: false },
  );

  const oversized = fakeS3(() => ({ ContentLength: 101, Body: body(stored()) }));
  await assert.rejects(
    new S3SessionStore({
      bucket: 'bucket',
      maxBytes: 100,
      client: oversized.client as never,
    }).load('large'),
    { code: 'SESSION_TOO_LARGE', recoverable: false },
  );

  const unavailable = fakeS3(() => {
    throw awsError('ServiceUnavailable', 503);
  });
  await assert.rejects(
    new S3SessionStore({ bucket: 'bucket', client: unavailable.client as never }).load('retry'),
    { code: 'SESSION_S3_REQUEST_FAILED', recoverable: true },
  );
});

test('tiered storage restores from durable state, caches it, and promotes legacy local data', async () => {
  const durable = new InMemorySessionStore();
  const cache = new InMemorySessionStore();
  await durable.save(stored('durable'));
  const tiered = new TieredSessionStore(cache, durable);

  assert.deepEqual(await tiered.load('durable'), stored('durable'));
  await durable.delete('durable');
  assert.deepEqual(await tiered.load('durable'), stored('durable'));

  await cache.save(stored('legacy'));
  assert.deepEqual(await tiered.load('legacy'), stored('legacy'));
  assert.deepEqual(await durable.load('legacy'), stored('legacy'));
});

test('tiered storage writes the durable copy before acknowledging the local cache', async () => {
  const order: string[] = [];
  const cache = {
    async load() {
      return undefined;
    },
    async save() {
      order.push('cache');
    },
    async delete() {
      return false;
    },
    async list() {
      return [];
    },
  };
  const durable = {
    ...cache,
    async save() {
      order.push('durable');
    },
  };
  const tiered = new TieredSessionStore(cache, durable);
  await tiered.save(stored());
  assert.deepEqual(order, ['durable', 'cache']);
});

test('lists and deletes sessions through the configured S3 prefix', async () => {
  const objects = new Map<string, { value: unknown; etag: string }>();
  const fake = fakeS3((command) => {
    const key = String(command.input.Key ?? '');
    switch (command.constructor.name) {
      case 'PutObjectCommand': {
        const value = JSON.parse(String(command.input.Body)) as unknown;
        objects.set(key, { value, etag: '"stored"' });
        return { ETag: '"stored"' };
      }
      case 'GetObjectCommand': {
        const object = objects.get(key);
        if (!object) throw awsError('NoSuchKey', 404);
        return { ETag: object.etag, Body: body(object.value) };
      }
      case 'ListObjectsV2Command':
        return { Contents: [...objects.keys()].map((Key) => ({ Key })) };
      case 'DeleteObjectCommand':
        objects.delete(key);
        return {};
      default:
        throw new Error(`Unexpected command ${command.constructor.name}`);
    }
  });
  const store = new S3SessionStore({
    bucket: 'bucket',
    prefix: '/tenant-a/sessions/',
    client: fake.client as never,
  });

  await store.save(stored('one'));
  assert.deepEqual(await store.list(), [
    {
      id: 'one',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T01:00:00.000Z',
      metadata: { agentName: 'sap-agent' },
    },
  ]);
  assert.equal(await store.delete('one'), true);
  assert.equal(await store.delete('one'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { locate } from '../../src/content/content-store.js';
import { S3ContentStore } from '../../src/content/s3-content-store.js';

type SentCommand = {
  constructor: { name: string };
  input: Record<string, unknown>;
};

type SendOptions = {
  abortSignal?: AbortSignal;
};

type SendHandler = (command: SentCommand, options: SendOptions) => unknown | Promise<unknown>;

function fakeS3(handler: SendHandler) {
  const commands: SentCommand[] = [];
  const client = {
    send(command: SentCommand, options: SendOptions) {
      commands.push(command);
      return Promise.resolve().then(() => handler(command, options));
    },
  };
  return { client, commands };
}

function storeFor(
  fake: ReturnType<typeof fakeS3>,
  overrides: { requestTimeoutMs?: number; maxObjectBytes?: number } = {},
): S3ContentStore {
  return new S3ContentStore({
    bucket: 'unit-test-bucket',
    client: fake.client as never,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 250,
    maxObjectBytes: overrides.maxObjectBytes ?? 1_024,
  });
}

function byteBody(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return {
    async transformToByteArray(): Promise<Uint8Array> {
      return bytes;
    },
  };
}

function errorWithStatus(name: string, message: string, status: number): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

test('load GETs the configured bucket and derives the content location', async () => {
  const text = '# Review skill\n\nCheck every boundary.';
  const fake = fakeS3(() => ({
    ContentLength: Buffer.byteLength(text),
    Body: byteBody(text),
  }));
  const store = storeFor(fake);

  const loaded = await store.load('skills/review/SKILL.md');

  assert.deepEqual(loaded, {
    location: locate('skills/review/SKILL.md', text),
    text,
  });
  assert.equal(fake.commands.length, 1);
  assert.equal(fake.commands[0]?.constructor.name, 'GetObjectCommand');
  assert.deepEqual(fake.commands[0]?.input, {
    Bucket: 'unit-test-bucket',
    Key: 'skills/review/SKILL.md',
  });
});

test('write PUTs UTF-8 Markdown metadata and returns its location', async () => {
  const text = '# Café\n';
  const fake = fakeS3(() => ({}));
  const store = storeFor(fake);

  const location = await store.write('agents/reviewer.md', text);

  assert.deepEqual(location, locate('agents/reviewer.md', text));
  assert.equal(fake.commands.length, 1);
  assert.equal(fake.commands[0]?.constructor.name, 'PutObjectCommand');
  assert.deepEqual(fake.commands[0]?.input, {
    Bucket: 'unit-test-bucket',
    Key: 'agents/reviewer.md',
    Body: text,
    ContentLength: Buffer.byteLength(text, 'utf8'),
    ContentType: 'text/markdown; charset=utf-8',
  });
});

test('read accepts matching content and refuses a checksum mismatch', async () => {
  const text = 'Pinned agent instructions';
  const fake = fakeS3(() => ({ Body: byteBody(text) }));
  const store = storeFor(fake);
  const location = locate('agents/reviewer.md', text);

  assert.equal(await store.read(location), text);
  await assert.rejects(store.read({ ...location, sha256: '0'.repeat(64) }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CONTENT_CHECKSUM_MISMATCH');
    assert.equal((error as { recoverable?: boolean }).recoverable, false);
    assert.match((error as Error).message, /object was replaced/i);
    return true;
  });
});

test('404, access-denied, and retryable failures retain distinct semantics', async () => {
  const fake = fakeS3((command) => {
    const key = String(command.input.Key);
    if (key === 'missing.md') {
      throw errorWithStatus('NoSuchKey', 'not here', 404);
    }
    if (key === 'private.md') {
      throw errorWithStatus('AccessDenied', 'role cannot read this prefix', 403);
    }
    const error = errorWithStatus('ServiceUnavailable', 'try later', 503);
    return Promise.reject(Object.assign(error, { $retryable: {} }));
  });
  const store = storeFor(fake);

  await assert.rejects(store.load('missing.md'), {
    code: 'CONTENT_NOT_FOUND',
    recoverable: false,
  });
  await assert.rejects(store.load('private.md'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CONTENT_REQUEST_FAILED');
    assert.equal((error as { recoverable?: boolean }).recoverable, false);
    assert.match((error as Error).message, /AccessDenied|role cannot read/);
    return true;
  });
  await assert.rejects(store.load('retry.md'), {
    code: 'CONTENT_REQUEST_FAILED',
    recoverable: true,
  });
});

test('a declared oversized object is rejected before its body is read', async () => {
  let transformed = false;
  let destroyed = false;
  const body = {
    destroy() {
      destroyed = true;
    },
    async transformToByteArray(): Promise<Uint8Array> {
      transformed = true;
      return Buffer.from('123456');
    },
  };
  const fake = fakeS3(() => ({ ContentLength: 6, Body: body }));
  const store = storeFor(fake, { maxObjectBytes: 5 });

  await assert.rejects(store.load('large.md'), {
    code: 'CONTENT_TOO_LARGE',
    recoverable: false,
  });
  assert.equal(transformed, false);
  assert.equal(destroyed, true);
});

test('a streamed object is stopped when its chunks cross the byte limit', async () => {
  let closed = false;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      yield Buffer.from('123');
      yield Buffer.from('456');
      yield Buffer.from('unreachable');
    } finally {
      closed = true;
    }
  }
  const fake = fakeS3(() => ({ Body: chunks() }));
  const store = storeFor(fake, { maxObjectBytes: 5 });

  await assert.rejects(store.load('streamed-large.md'), {
    code: 'CONTENT_TOO_LARGE',
    recoverable: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});

test('a body that does not arrive before the deadline fails as a recoverable timeout', async () => {
  let slowTimer: NodeJS.Timeout | undefined;
  const body = {
    transformToByteArray(): Promise<Uint8Array> {
      return new Promise((resolve) => {
        slowTimer = setTimeout(() => resolve(Buffer.from('eventually')), 100);
      });
    },
  };
  const fake = fakeS3(() => ({ Body: body }));
  const store = storeFor(fake, { requestTimeoutMs: 10 });

  try {
    await assert.rejects(store.load('slow.md'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONTENT_TIMEOUT');
      assert.equal((error as { recoverable?: boolean }).recoverable, true);
      assert.match((error as Error).message, /timed out/);
      return true;
    });
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
  }
});

test('invalid UTF-8 is refused instead of being replacement-decoded', async () => {
  const fake = fakeS3(() => ({
    ContentLength: 2,
    Body: byteBody(Uint8Array.from([0xc3, 0x28])),
  }));
  const store = storeFor(fake);

  await assert.rejects(store.load('binary.md'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CONTENT_INVALID_ENCODING');
    assert.equal((error as { recoverable?: boolean }).recoverable, false);
    assert.match((error as Error).message, /not valid UTF-8/);
    return true;
  });
});

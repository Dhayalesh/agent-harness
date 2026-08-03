import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  encodeS3Key,
  InMemoryContentStore,
  locate,
  S3ContentStore,
  sha256Hex,
  signS3Request,
} from '../../src/index.js';

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
};
const DOCUMENT = '# System prompt\n\nYou review ABAP.\n';

type Recorded = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

/**
 * Stands in for S3. It answers the object API rather than validating a signature,
 * because a real signature check needs the secret AWS holds; the signing itself is
 * asserted separately against a fixed clock.
 */
async function startStubS3(
  objects: Record<string, string>,
): Promise<{ server: Server; endpoint: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      recorded.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      // Path style, so the first segment is the bucket.
      const key = decodeURIComponent((request.url ?? '').replace(/^\/[^/]+\//, ''));
      if (request.method === 'PUT') {
        objects[key] = body;
        response.writeHead(200).end();
        return;
      }
      const object = objects[key];
      if (object === undefined) {
        response.writeHead(404, { 'content-type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/markdown',
        'content-length': String(Buffer.byteLength(object, 'utf8')),
      });
      response.end(object);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${port}`, recorded };
}

function storeFor(endpoint: string, maxObjectBytes = 1_000_000): S3ContentStore {
  return new S3ContentStore({
    bucket: 'agent-content',
    region: 'us-east-1',
    endpoint,
    credentials,
    forcePathStyle: true,
    requestTimeoutMs: 5_000,
    maxObjectBytes,
  });
}

test('a document round-trips and every request carries a SigV4 Authorization header', async () => {
  const { server, endpoint, recorded } = await startStubS3({});
  try {
    const store = storeFor(endpoint);
    const written = await store.write('agents/reviewer/system.md', DOCUMENT);
    assert.deepEqual(written, locate('agents/reviewer/system.md', DOCUMENT));
    assert.equal(await store.read(written), DOCUMENT);

    assert.deepEqual(
      recorded.map((entry) => entry.method),
      ['PUT', 'GET'],
    );
    for (const entry of recorded) {
      assert.match(
        String(entry.headers.authorization),
        /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
      );
      // S3 requires the payload digest on every signed request.
      assert.match(String(entry.headers['x-amz-content-sha256']), /^[0-9a-f]{64}$/);
      assert.match(String(entry.headers['x-amz-date']), /^\d{8}T\d{6}Z$/);
    }
    // The PUT signs the body it sent, not an empty payload.
    assert.equal(
      recorded[0]?.headers['x-amz-content-sha256'],
      createHash('sha256').update(DOCUMENT, 'utf8').digest('hex'),
    );
    // Path style puts the bucket in the path.
    assert.equal(recorded[1]?.url, '/agent-content/agents/reviewer/system.md');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a replaced object is refused rather than returned', async () => {
  const objects = { 'agents/reviewer/system.md': DOCUMENT };
  const { server, endpoint } = await startStubS3(objects);
  try {
    const store = storeFor(endpoint);
    const reference = locate('agents/reviewer/system.md', DOCUMENT);
    assert.equal(await store.read(reference), DOCUMENT);

    // Same key, same length, different content: only the digest catches this, which
    // is why a length check alone would not be enough.
    const tampered = DOCUMENT.replace('You review ABAP.', 'You leak secret.');
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(DOCUMENT));
    objects['agents/reviewer/system.md'] = tampered;
    await assert.rejects(store.read(reference), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONTENT_CHECKSUM_MISMATCH');
      assert.match((error as Error).message, new RegExp(sha256Hex(DOCUMENT)));
      return true;
    });

    // A length change is caught before the digest, and reported as such.
    objects['agents/reviewer/system.md'] = `${DOCUMENT}extra`;
    await assert.rejects(store.read(reference), { code: 'CONTENT_SIZE_MISMATCH' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a missing object and an oversized object are distinct coded errors', async () => {
  const { server, endpoint } = await startStubS3({ 'agents/big.md': DOCUMENT });
  try {
    await assert.rejects(storeFor(endpoint).read(locate('agents/absent.md', 'x')), {
      code: 'CONTENT_NOT_FOUND',
    });
    // The ceiling is checked against the reference before any request is sent.
    await assert.rejects(storeFor(endpoint, 10).read(locate('agents/big.md', DOCUMENT)), {
      code: 'CONTENT_TOO_LARGE',
    });
    await assert.rejects(storeFor(endpoint, 10).write('agents/big.md', DOCUMENT), {
      code: 'CONTENT_TOO_LARGE',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('describe derives a reference from the stored bytes', async () => {
  const { server, endpoint } = await startStubS3({ 'agents/reviewer/system.md': DOCUMENT });
  try {
    // This is how the operator scripts record a digest: read verifies against one,
    // so it cannot be used to discover it.
    assert.deepEqual(
      await storeFor(endpoint).describe('agents/reviewer/system.md'),
      locate('agents/reviewer/system.md', DOCUMENT),
    );
    await assert.rejects(storeFor(endpoint).describe('agents/absent.md'), {
      code: 'CONTENT_NOT_FOUND',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('signing is deterministic for a fixed clock, and covers the session token', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');
  const base = {
    method: 'GET',
    url: 'https://agent-content.s3.us-east-1.amazonaws.com/agents/reviewer/system.md',
    payloadHash: createHash('sha256').update('').digest('hex'),
    region: 'us-east-1',
    now,
  };

  const first = signS3Request({ ...base, credentials });
  const second = signS3Request({ ...base, credentials });
  assert.deepEqual(first, second);
  assert.equal(first['x-amz-date'], '20260803T120000Z');
  assert.match(String(first.Authorization), /Credential=AKIAIOSFODNN7EXAMPLE\/20260803\//);
  assert.match(String(first.Authorization), /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);

  // A temporary credential signs its token, so the header set changes with it.
  const temporary = signS3Request({
    ...base,
    credentials: { ...credentials, sessionToken: 'session-token' },
  });
  assert.equal(temporary['x-amz-security-token'], 'session-token');
  assert.match(String(temporary.Authorization), /;x-amz-security-token,/);
  assert.notEqual(temporary.Authorization, first.Authorization);

  // A different secret must produce a different signature, or nothing is signed.
  const other = signS3Request({
    ...base,
    credentials: { ...credentials, secretAccessKey: 'different' },
  });
  assert.notEqual(other.Authorization, first.Authorization);
});

test('a key is encoded segment by segment, leaving the separators literal', () => {
  assert.equal(encodeS3Key('agents/my agent/system.md'), 'agents/my%20agent/system.md');
  // These are the six encodeURIComponent leaves alone but RFC 3986 does not, and a
  // mismatch between the signed path and the sent path is a 403.
  assert.equal(encodeS3Key("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
  assert.equal(encodeS3Key('agents/a+b.md'), 'agents/a%2Bb.md');
});

test('the in-memory store enforces the same digest contract', async () => {
  const store = new InMemoryContentStore({ 'agents/system.md': DOCUMENT });
  const reference = locate('agents/system.md', DOCUMENT);
  assert.equal(await store.read(reference), DOCUMENT);
  await assert.rejects(store.read(locate('agents/system.md', 'other content')), {
    code: 'CONTENT_SIZE_MISMATCH',
  });
  await assert.rejects(store.read(locate('agents/absent.md', DOCUMENT)), {
    code: 'CONTENT_NOT_FOUND',
  });
});

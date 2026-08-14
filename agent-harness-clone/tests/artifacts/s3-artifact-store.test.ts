import assert from 'node:assert/strict';
import test from 'node:test';
import { S3ArtifactStore } from '../../src/artifacts/s3-artifact-store.js';

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

test('uploads Markdown immutably and returns a durable S3 reference', async () => {
  const fake = fakeS3(() => ({
    ETag: '"revision-1"',
    VersionId: 'version-1',
    ChecksumSHA256: 'server-checksum',
  }));
  const store = new S3ArtifactStore({
    bucket: 'private-agent-artifacts',
    prefix: '/production/markdown/',
    region: 'us-east-1',
    client: fake.client as never,
  });

  const artifact = await store.put('# Launch plan', {
    contentType: 'text/markdown; charset=utf-8',
    metadata: {
      title: 'Launch plan',
      filename: 'launch-plan.md',
      presentation: 'file',
    },
  });

  const put = fake.commands[0];
  assert.equal(put?.constructor.name, 'PutObjectCommand');
  assert.equal(put?.input.Bucket, 'private-agent-artifacts');
  assert.match(String(put?.input.Key), /^production\/markdown\/[\w-]+\.md$/);
  assert.equal(put?.input.IfNoneMatch, '*');
  assert.equal(put?.input.ServerSideEncryption, 'AES256');
  assert.equal(put?.input.SSEKMSKeyId, undefined);
  assert.equal(put?.input.ContentType, 'text/markdown; charset=utf-8');
  assert.equal(artifact.storage?.kind, 's3');
  assert.equal(artifact.storage?.bucket, 'private-agent-artifacts');
  assert.equal(artifact.storage?.key, put?.input.Key);
  assert.equal(artifact.storage?.versionId, 'version-1');
  assert.equal(artifact.storage?.checksumSha256, 'server-checksum');
});

test('does not emit an artifact when the S3 write fails', async () => {
  const fake = fakeS3(() => {
    throw Object.assign(new Error('unavailable'), {
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });
  });
  const store = new S3ArtifactStore({
    bucket: 'private-agent-artifacts',
    client: fake.client as never,
  });

  await assert.rejects(store.put('# Not stored', { contentType: 'text/markdown' }), {
    code: 'ARTIFACT_S3_REQUEST_FAILED',
    recoverable: true,
  });
});

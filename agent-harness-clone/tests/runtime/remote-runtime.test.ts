import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createInMemoryChannelPair,
  LocalRuntimeHost,
  RemoteRuntimeHost,
  RuntimeRpcServer,
  type RuntimeRpcMessage,
} from '../../src/index.js';

test('remote runtime exposes only the host capabilities over a serializable channel', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-runtime-'));
  await writeFile(path.join(directory, 'file.txt'), 'remote contents');
  const [clientChannel, serverChannel] = createInMemoryChannelPair<RuntimeRpcMessage>();
  const server = new RuntimeRpcServer(serverChannel, new LocalRuntimeHost(directory));
  const client = new RemoteRuntimeHost(clientChannel, directory);
  try {
    assert.equal(await client.readText('file.txt'), 'remote contents');
    await client.writeText('created.txt', 'created remotely');
    assert.equal(await client.readText('created.txt'), 'created remotely');
    const result = await client.execute('node -e "process.stdout.write(\'rpc\')"', {
      signal: new AbortController().signal,
    });
    assert.equal(result.stdout, 'rpc');
    await assert.rejects(client.readText('../outside'), /outside the runtime workspace/);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

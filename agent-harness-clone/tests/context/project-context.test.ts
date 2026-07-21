import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalProjectContextProvider, LocalRuntimeHost } from '../../src/index.js';

test('local project context collects bounded environment metadata', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'project-context-'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture' }));
  try {
    const context = await new LocalProjectContextProvider(new LocalRuntimeHost(directory)).collect(
      new AbortController().signal,
    );
    assert.equal(context.packageName, 'fixture');
    assert.equal(context.workingDirectory, directory);
    assert.ok(context.nodeVersion);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

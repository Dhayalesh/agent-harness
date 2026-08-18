import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryArtifactStore, type Artifact } from '../../src/artifacts/artifact-store.js';
import {
  artifactFilename,
  codeLanguageFromFilename,
} from '../../src/artifacts/artifact-formats.js';
import { createCodeArtifactTool } from '../../src/tools/builtin/create-code-artifact.js';
import { createJsonArtifactTool } from '../../src/tools/builtin/create-json-artifact.js';
import type { ToolExecutionContext, ToolExecutionResult } from '../../src/tools/tool.js';

const context: ToolExecutionContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'call-1',
  workingDirectory: process.cwd(),
  signal: new AbortController().signal,
  messages: [],
  reportProgress() {},
};

function artifactFrom(result: ToolExecutionResult): Artifact {
  const artifact = result.metadata?.artifact;
  assert.ok(artifact && typeof artifact === 'object');
  return artifact as Artifact;
}

test('JSON artifact reformats content and normalizes its filename', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createJsonArtifactTool(store).execute(
    { title: 'Config', filename: '../etc/config', content: '{"b":1,"a":[2,3]}', format: 'json' },
    context,
  );
  const artifact = artifactFrom(result);

  assert.equal(result.isError, undefined);
  assert.equal(artifact.contentType, 'application/json; charset=utf-8');
  // Only the last path segment survives, so a traversal attempt cannot name the file.
  assert.equal(artifact.metadata.filename, 'config.json');
  assert.equal(artifact.metadata.kind, 'json');
  assert.equal(artifact.metadata.presentation, 'file');
  assert.equal(await store.get(artifact.id), '{\n  "b": 1,\n  "a": [\n    2,\n    3\n  ]\n}\n');
});

test('JSON artifact reports invalid JSON as a tool error instead of storing it', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createJsonArtifactTool(store).execute(
    { title: 'Config', filename: 'config', content: '{"a":}', format: 'json' },
    context,
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /not valid JSON/);
  assert.equal(result.metadata, undefined);
});

test('NDJSON artifact compacts one record per line and drops blank lines', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createJsonArtifactTool(store).execute(
    {
      title: 'Events',
      filename: 'events',
      content: '{ "id": 1 }\n\n{ "id": 2 }\n',
      format: 'ndjson',
    },
    context,
  );
  const artifact = artifactFrom(result);

  assert.equal(artifact.metadata.filename, 'events.ndjson');
  assert.equal(artifact.metadata.kind, 'ndjson');
  assert.equal(artifact.metadata.records, 2);
  assert.equal(await store.get(artifact.id), '{"id":1}\n{"id":2}\n');
  assert.match(result.content, /2 records/);
});

test('NDJSON artifact names the offending line when a record does not parse', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createJsonArtifactTool(store).execute(
    { title: 'Events', filename: 'events', content: '{"id":1}\nnope\n', format: 'ndjson' },
    context,
  );

  assert.equal(result.isError, true);
  assert.match(result.content, /Line 2 is not valid JSON/);
});

test('code artifact takes its extension from the language and stays text/plain', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createCodeArtifactTool(store).execute(
    {
      title: 'Fetch client',
      filename: 'client',
      language: 'go',
      content: 'package main\n\nfunc main() {}\n',
    },
    context,
  );
  const artifact = artifactFrom(result);

  assert.equal(artifact.metadata.filename, 'client.go');
  assert.equal(artifact.metadata.kind, 'code');
  assert.equal(artifact.metadata.language, 'go');
  // Never a language-specific type: these bytes are served back to a browser.
  assert.equal(artifact.contentType, 'text/plain; charset=utf-8');
  assert.equal(await store.get(artifact.id), 'package main\n\nfunc main() {}\n');
});

test('code artifact keeps a filename that already carries the right extension', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createCodeArtifactTool(store).execute(
    { title: 'Types', filename: 'src/types.ts', language: 'typescript', content: 'export {};\n' },
    context,
  );

  assert.equal(artifactFrom(result).metadata.filename, 'types.ts');
});

test('code filenames resolve the longest matching extension', () => {
  assert.equal(artifactFilename('app', 'code', { language: 'tsx' }), 'app.tsx');
  assert.equal(codeLanguageFromFilename('app.tsx'), 'tsx');
  assert.equal(codeLanguageFromFilename('app.ts'), 'typescript');
  assert.equal(codeLanguageFromFilename('notes.md'), undefined);
});

test('a code kind with no language falls back to a plain-text extension', () => {
  assert.equal(artifactFilename('scratch', 'code'), 'scratch.txt');
});

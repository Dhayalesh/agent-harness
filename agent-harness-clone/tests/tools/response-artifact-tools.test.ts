import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { InMemoryArtifactStore, type Artifact } from '../../src/artifacts/artifact-store.js';
import { createCsvArtifactTool } from '../../src/tools/builtin/create-csv-artifact.js';
import { createDocumentArtifactTool } from '../../src/tools/builtin/create-document-artifact.js';
import { createHtmlArtifactTool } from '../../src/tools/builtin/create-html-artifact.js';
import { createSpreadsheetArtifactTool } from '../../src/tools/builtin/create-spreadsheet-artifact.js';
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

test('HTML artifact preserves source and normalizes its filename', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createHtmlArtifactTool(store).execute(
    { title: 'Status report', filename: '../status', content: '<h1>Ready</h1>' },
    context,
  );
  const artifact = artifactFrom(result);

  assert.equal(artifact.contentType, 'text/html; charset=utf-8');
  assert.equal(artifact.metadata.filename, 'status.html');
  assert.equal(artifact.metadata.kind, 'html');
  assert.equal(await store.get(artifact.id), '<h1>Ready</h1>');
});

test('DOCX artifact is built as an OOXML zip', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createDocumentArtifactTool(store).execute(
    { title: 'Runbook', filename: 'runbook', content: '# Runbook\n\n- First step' },
    context,
  );
  const artifact = artifactFrom(result);
  const bytes = await store.get(artifact.id);

  assert.equal(artifact.metadata.filename, 'runbook.docx');
  assert.equal(artifact.metadata.kind, 'docx');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
});

test('XLSX artifact builds sheets and neutralizes formula-like strings', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createSpreadsheetArtifactTool(store).execute(
    {
      title: 'Accounts',
      filename: 'accounts',
      sheets: [{ name: 'Q1/Results', columns: ['Name', 'Value'], rows: [['Alice', '=2+2']] }],
    },
    context,
  );
  const artifact = artifactFrom(result);
  const bytes = await store.get(artifact.id);
  assert.ok(bytes instanceof Uint8Array);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);

  assert.equal(artifact.metadata.filename, 'accounts.xlsx');
  assert.equal(workbook.worksheets[0]?.name, 'Q1-Results');
  assert.equal(workbook.worksheets[0]?.getCell('B2').value, "'=2+2");
});

test('CSV artifact quotes values and neutralizes spreadsheet formulas', async () => {
  const store = new InMemoryArtifactStore();
  const result = await createCsvArtifactTool(store).execute(
    {
      title: 'Contacts',
      filename: 'contacts',
      columns: ['Name', 'Note'],
      rows: [
        ['Alice', 'hello, world'],
        ['Bob', '=cmd()'],
      ],
    },
    context,
  );
  const artifact = artifactFrom(result);
  const content = await store.get(artifact.id);

  assert.equal(artifact.metadata.filename, 'contacts.csv');
  assert.equal(artifact.metadata.kind, 'csv');
  assert.equal(content, '\uFEFFName,Note\r\nAlice,"hello, world"\r\nBob,\'=cmd()\r\n');
});

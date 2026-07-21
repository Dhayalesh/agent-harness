import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createBuiltinTools,
  LocalRuntimeHost,
  type Tool,
  type ToolExecutionContext,
} from '../../src/index.js';

async function withWorkspace(
  run: (directory: string, tools: Map<string, Tool>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-harness-'));
  try {
    const runtime = new LocalRuntimeHost(directory);
    const tools = new Map(createBuiltinTools(runtime).map((tool) => [tool.name, tool]));
    await run(directory, tools);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function context(directory: string): ToolExecutionContext {
  return {
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    workingDirectory: directory,
    signal: new AbortController().signal,
    messages: [],
    reportProgress() {},
  };
}

test('read, edit, glob, grep, and bash operate in a workspace', async () => {
  await withWorkspace(async (directory, tools) => {
    await writeFile(path.join(directory, 'hello.ts'), 'export const value = 1;\n');
    const read = tools.get('read_file');
    const edit = tools.get('edit_file');
    const glob = tools.get('glob');
    const grep = tools.get('grep');
    const bash = tools.get('bash');
    assert.ok(read && edit && glob && grep && bash);

    const readResult = await read.execute({ path: 'hello.ts' }, context(directory));
    assert.match(readResult.content, /export const value = 1/);
    await edit.execute(
      { path: 'hello.ts', oldText: 'value = 1', newText: 'value = 2' },
      context(directory),
    );
    assert.match(await readFile(path.join(directory, 'hello.ts'), 'utf8'), /value = 2/);
    assert.match(
      (await glob.execute({ pattern: '**/*.ts' }, context(directory))).content,
      /hello\.ts/,
    );
    assert.match(
      (await grep.execute({ query: 'value = 2' }, context(directory))).content,
      /hello\.ts:1/,
    );
    assert.match(
      (
        await bash.execute(
          { command: 'node -e "process.stdout.write(\'ok\')"' },
          context(directory),
        )
      ).content,
      /ok/,
    );
  });
});

test('runtime rejects paths outside its workspace', async () => {
  await withWorkspace(async (directory) => {
    const runtime = new LocalRuntimeHost(directory);
    await assert.rejects(runtime.readText('../outside.txt'), /outside the runtime workspace/);
    await assert.rejects(
      runtime.writeText('../outside.txt', 'no'),
      /outside the runtime workspace/,
    );
  });
});

test('aborting shell execution terminates the process group promptly', async () => {
  await withWorkspace(async (directory) => {
    const runtime = new LocalRuntimeHost(directory);
    const controller = new AbortController();
    const started = performance.now();
    const execution = runtime.execute(
      'node -e "setInterval(() => process.stdout.write(\'tick\'), 100)"',
      { signal: controller.signal, timeoutMs: 10_000 },
    );
    setTimeout(() => controller.abort('test'), 50);
    await assert.rejects(execution, /interrupted/);
    assert.ok(performance.now() - started < 1_000);
  });
});

test('edit requires the file to be read first', async () => {
  await withWorkspace(async (directory, tools) => {
    await writeFile(path.join(directory, 'file.txt'), 'before');
    const edit = tools.get('edit_file');
    assert.ok(edit);
    await assert.rejects(
      edit.execute({ path: 'file.txt', oldText: 'before', newText: 'after' }, context(directory)),
      /must be read/,
    );
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AllowAllPermissionHandler,
  CliAgentAdapter,
  createAgentSession,
  createBuiltinTools,
  DesktopAgentAdapter,
  IdeAgentAdapter,
  LocalRuntimeHost,
  ScriptedModelProvider,
  SessionGateway,
  startAgentSseServer,
  type AgentEvent,
  type AgentSession,
} from '../../src/index.js';

test('coding acceptance trajectory works through SDK, CLI, server, desktop, and IDE', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cross-surface-'));
  const fixture = path.join(directory, 'fixture.txt');

  const createSession = (): AgentSession => {
    const runtime = new LocalRuntimeHost(directory);
    return createAgentSession({
      provider: new ScriptedModelProvider([
        [
          { type: 'tool_call', id: 'read', name: 'read_file', input: { path: 'fixture.txt' } },
          { type: 'completed', stopReason: 'tool_use' },
        ],
        [
          {
            type: 'tool_call',
            id: 'edit',
            name: 'edit_file',
            input: { path: 'fixture.txt', oldText: 'bad', newText: 'good' },
          },
          { type: 'completed', stopReason: 'tool_use' },
        ],
        [
          {
            type: 'tool_call',
            id: 'test',
            name: 'bash',
            input: {
              command:
                "node -e \"const fs=require('fs');if(!fs.readFileSync('fixture.txt','utf8').includes('good'))process.exit(1);process.stdout.write('tests passed')\"",
            },
          },
          { type: 'completed', stopReason: 'tool_use' },
        ],
        [
          { type: 'text_delta', delta: 'Fixed the fixture and verified the test.' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      ]),
      workingDirectory: directory,
      tools: createBuiltinTools(runtime),
      permissionHandler: new AllowAllPermissionHandler(),
    });
  };

  const assertCompleted = async (events: readonly AgentEvent[]): Promise<void> => {
    assert.ok(
      events.some(
        (event) => event.type === 'assistant.text.delta' && event.delta.includes('verified'),
      ),
    );
    assert.match(await readFile(fixture, 'utf8'), /good/);
  };

  try {
    await writeFile(fixture, 'bad');
    const sdkEvents: AgentEvent[] = [];
    for await (const event of createSession().run({ prompt: 'fix' })) sdkEvents.push(event);
    await assertCompleted(sdkEvents);

    await writeFile(fixture, 'bad');
    await assertCompleted(await new CliAgentAdapter().run(createSession(), 'fix'));

    await writeFile(fixture, 'bad');
    const gateway = new SessionGateway({ createSession });
    const desktop = new DesktopAgentAdapter(gateway, 'desktop');
    const desktopSession = await desktop.createSession();
    await assertCompleted(await desktop.run(desktopSession, 'fix'));

    await writeFile(fixture, 'bad');
    const ide = new IdeAgentAdapter(gateway, 'ide');
    const ideSession = await ide.createSession();
    await assertCompleted(
      await ide.run(ideSession, 'fix', {
        workspace: directory,
        activeFile: fixture,
      }),
    );

    await writeFile(fixture, 'bad');
    const server = await startAgentSseServer({ createSession });
    try {
      const response = await fetch(`${server.url}/sessions/run`, {
        method: 'POST',
        body: JSON.stringify({ prompt: 'fix' }),
      });
      const body = await response.text();
      assert.match(body, /Fixed the fixture and verified the test/);
      assert.match(await readFile(fixture, 'utf8'), /good/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

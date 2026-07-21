import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createAgentSession,
  LocalRuntimeHost,
  ScriptedModelProvider,
  TaskManager,
} from '../../src/index.js';

test('background shell and subagent tasks complete with correlated output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-task-'));
  const manager = new TaskManager({
    runtime: new LocalRuntimeHost(directory),
    createSubagent: () =>
      createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'subagent result' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
        limits: { maxTurns: 2 },
      }),
  });
  try {
    const shell = manager.startShell({
      command: 'node -e "process.stdout.write(\'background\')"',
      parentSessionId: 'parent',
      parentToolCallId: 'call',
    });
    const shellDone = await manager.wait(shell.id);
    assert.equal(shellDone.status, 'completed');
    assert.match(shellDone.output, /background/);
    assert.equal(shellDone.parentSessionId, 'parent');

    const agent = manager.startAgent({ prompt: 'work', parentSessionId: 'parent' });
    const agentDone = await manager.wait(agent.id);
    assert.equal(agentDone.status, 'completed');
    assert.match(agentDone.output, /subagent result/);
  } finally {
    await manager.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrency quota prevents unbounded background work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-task-limit-'));
  const manager = new TaskManager({
    runtime: new LocalRuntimeHost(directory),
    maxConcurrent: 1,
  });
  try {
    const task = manager.startShell({ command: 'node -e "setTimeout(() => {}, 1000)"' });
    assert.throws(() => manager.startShell({ command: 'echo no' }), /limit reached/);
    manager.stop(task.id);
    assert.equal((await manager.wait(task.id)).status, 'cancelled');
  } finally {
    await manager.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSession,
  DesktopAgentAdapter,
  IdeAgentAdapter,
  ScriptedModelProvider,
  SessionGateway,
} from '../../src/index.js';

test('desktop and IDE adapters share gateway idempotency and replay semantics', async () => {
  let sessions = 0;
  const gateway = new SessionGateway({
    createSession: () => {
      sessions += 1;
      return createAgentSession({
        provider: new ScriptedModelProvider([
          [
            { type: 'text_delta', delta: 'surface answer' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        ]),
      });
    },
  });
  const desktop = new DesktopAgentAdapter(gateway, 'desktop-1');
  const desktopSession = await desktop.createSession();
  const first = await desktop.run(desktopSession, 'work', 'same-run');
  const duplicate = await desktop.run(desktopSession, 'ignored duplicate', 'same-run');
  assert.deepEqual(duplicate, first);
  assert.deepEqual(desktop.replay(desktopSession.sessionId), first);
  assert.throws(() => gateway.interrupt(desktopSession.sessionId, 'wrong-token'), /control denied/);

  const ide = new IdeAgentAdapter(gateway, 'ide-1');
  const ideSession = await ide.createSession();
  assert.equal(sessions, 2);
  await ide.run(ideSession, 'explain', {
    activeFile: 'src/index.ts',
    selection: { text: 'const value = 1', startLine: 1, endLine: 1 },
  });
});

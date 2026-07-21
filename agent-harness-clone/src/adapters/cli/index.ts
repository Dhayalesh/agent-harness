#!/usr/bin/env node
import { createAgentSession } from '../../core/agent-session.js';
import { AnthropicModelProvider } from '../../models/anthropic-provider.js';
import { ScriptedModelProvider } from '../../models/scripted-provider.js';
import { LocalRuntimeHost } from '../../runtime/local-runtime-host.js';
import { createBuiltinTools } from '../../tools/builtin/index.js';
import { InteractiveCliPermissionHandler } from './interactive-permissions.js';

const prompt = process.argv.slice(2).join(' ').trim() || 'Hello';
const provider = process.env.ANTHROPIC_API_KEY
  ? new AnthropicModelProvider()
  : new ScriptedModelProvider([
      [
        {
          type: 'text_delta',
          delta: `The harness received: ${prompt}\nSet ANTHROPIC_API_KEY to run a live coding agent.`,
        },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]);
const runtime = new LocalRuntimeHost(process.cwd());
const session = createAgentSession({
  provider,
  workingDirectory: process.cwd(),
  tools: createBuiltinTools(runtime),
  permissionHandler: new InteractiveCliPermissionHandler(),
  systemPrompt:
    'You are a coding agent. Inspect the repository, make only approved changes, and verify your work.',
});

for await (const event of session.run({ prompt })) {
  if (event.type === 'assistant.text.delta') process.stdout.write(event.delta);
  if (event.type === 'tool.started') {
    process.stderr.write(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.input)}\n`);
  }
  if (event.type === 'tool.completed') {
    process.stderr.write(
      `[tool ${event.result.isError ? 'error' : 'done'}] ${event.result.content}\n`,
    );
  }
  if (event.type === 'session.completed') process.stdout.write('\n');
}

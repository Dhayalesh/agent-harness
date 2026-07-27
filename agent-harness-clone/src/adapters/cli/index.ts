#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createAgentSession } from '../../core/agent-session.js';
import {
  DEFAULT_OPENROUTER_MODEL,
  OpenRouterModelProvider,
} from '../../models/openrouter-provider.js';
import { ScriptedModelProvider } from '../../models/scripted-provider.js';
import { LocalRuntimeHost } from '../../runtime/local-runtime-host.js';
import { createBuiltinTools } from '../../tools/builtin/index.js';
import { createWebTools } from '../../tools/web/index.js';
import { InteractiveCliPermissionHandler } from './interactive-permissions.js';

const prompt = process.argv.slice(2).join(' ').trim() || 'Hello';
const model = process.env.AGENT_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
const maxOutputTokens = parsePositiveInteger(
  'AGENT_MAX_OUTPUT_TOKENS',
  process.env.AGENT_MAX_OUTPUT_TOKENS,
);
const maxTurns = parsePositiveInteger('AGENT_MAX_TURNS', process.env.AGENT_MAX_TURNS);
const limits = {
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  ...(maxTurns === undefined ? {} : { maxTurns }),
};
const provider = process.env.OPENROUTER_API_KEY
  ? new OpenRouterModelProvider({ defaultModel: model })
  : new ScriptedModelProvider([
      [
        {
          type: 'text_delta',
          delta: `The harness received: ${prompt}\nSet OPENROUTER_API_KEY to run a live agent (optionally AGENT_MODEL, default ${DEFAULT_OPENROUTER_MODEL}).`,
        },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    ]);
const systemPrompt = await resolveSystemPrompt();
const runtime = new LocalRuntimeHost(process.cwd());
const session = createAgentSession({
  provider,
  workingDirectory: process.cwd(),
  tools: [...createBuiltinTools(runtime), ...createWebTools()],
  permissionHandler: new InteractiveCliPermissionHandler(),
  ...(systemPrompt === undefined ? {} : { systemPrompt }),
  ...(Object.keys(limits).length === 0 ? {} : { limits }),
});

/**
 * The harness is task-neutral, so the CLI ships no built-in persona. Callers
 * supply one inline or from a file; with neither, the model runs on its own
 * defaults plus the tool descriptions.
 */
async function resolveSystemPrompt(): Promise<string | undefined> {
  const inline = process.env.AGENT_SYSTEM_PROMPT?.trim();
  if (inline) return inline;
  const path = process.env.AGENT_SYSTEM_PROMPT_FILE?.trim();
  if (!path) return undefined;
  const fromFile = (await readFile(path, 'utf8')).trim();
  return fromFile === '' ? undefined : fromFile;
}

function parsePositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

let failed = false;

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
  if (event.type === 'warning') {
    process.stderr.write(`\n[warning ${event.code}] ${event.message}\n`);
  }
  if (event.type === 'error') {
    failed = true;
    process.stderr.write(`\n[error ${event.code}] ${event.message}\n`);
  }
  if (event.type === 'session.completed') {
    process.stdout.write('\n');
    if (event.reason !== 'end_turn') {
      process.stderr.write(`[session ${event.reason}]\n`);
    }
  }
}

await session.close();
if (failed) process.exitCode = 1;

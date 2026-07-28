#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createAgentSession } from '../../core/agent-session.js';
import { resolveModelProviderFromDatabase } from '../../platform/model-provider-resolution.js';
import { LocalRuntimeHost } from '../../runtime/local-runtime-host.js';
import { createBuiltinTools } from '../../tools/builtin/index.js';
import { createWebTools } from '../../tools/web/index.js';
import { InteractiveCliPermissionHandler } from './interactive-permissions.js';

const prompt = process.argv.slice(2).join(' ').trim() || 'Hello';
const maxTurns = parsePositiveInteger('AGENT_MAX_TURNS', process.env.AGENT_MAX_TURNS);
// The configured record is the only source of a model and a credential; there
// is no offline stub and no environment-supplied default.
const { provider, record, close: closeModelProvider } = await resolveModelProviderFromDatabase();
// Both token ceilings come from the record's stored capabilities, alongside the
// model they apply to. The environment cannot raise or lower either one. The
// input budget is what the window leaves once the reply is reserved, so a full
// context plus a full reply cannot exceed `contextWindow`.
const limits = {
  maxOutputTokens: record.capabilities.maxOutputTokens,
  maxInputTokens: record.capabilities.contextWindow - record.capabilities.maxOutputTokens,
  ...(maxTurns === undefined ? {} : { maxTurns }),
};
process.stderr.write(
  `[model] ${record.name} -> ${record.provider} ${record.model} ` +
    `(maxInputTokens=${limits.maxInputTokens}, maxOutputTokens=${limits.maxOutputTokens})\n`,
);
const systemPrompt = await resolveSystemPrompt();
const runtime = new LocalRuntimeHost(process.cwd());
const session = createAgentSession({
  provider,
  workingDirectory: process.cwd(),
  tools: [...createBuiltinTools(runtime), ...createWebTools()],
  permissionHandler: new InteractiveCliPermissionHandler(),
  ...(systemPrompt === undefined ? {} : { systemPrompt }),
  limits,
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
await closeModelProvider();
if (failed) process.exitCode = 1;

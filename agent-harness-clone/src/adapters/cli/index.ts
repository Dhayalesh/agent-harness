#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createAgentSession } from '../../core/agent-session.js';
import { resolveMcpServersFromDatabase } from '../../platform/mcp-server-resolution.js';
import { resolveModelProviderFromDatabase } from '../../platform/model-provider-resolution.js';
import { LocalRuntimeHost } from '../../runtime/local-runtime-host.js';
import { PlanModePermissionHandler } from '../../permissions/plan-mode-permission-handler.js';
import { createBuiltinTools } from '../../tools/builtin/index.js';
import { createAskUserQuestionTool } from '../../tools/interactive/ask-user-question.js';
import { createPlanModeTools, PlanModeController } from '../../tools/planning/plan-mode.js';
import { createWebTools } from '../../tools/web/index.js';
import { InteractiveCliPermissionHandler } from './interactive-permissions.js';
import { InteractiveCliQuestionHandler } from './interactive-questions.js';
import { streamSessionToStdout } from './stream-events.js';

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
// MCP servers are additive: an empty `mcp_servers` collection leaves the session
// with its builtin tools, so this resolves to nothing rather than failing. The
// CLI passes no elicitation handler, so a record that asks for elicitation is
// reported by the registry and connected without it.
const mcp = await resolveMcpServersFromDatabase(undefined, {
  logger: (message) => process.stderr.write(`${message}\n`),
});
for (const record of mcp.records) {
  const target = record.transport === 'stdio' ? record.command : record.url;
  process.stderr.write(`[mcp] ${record.name} -> ${record.transport} ${target ?? ''}\n`);
}
if (mcp.tools.length > 0) {
  process.stderr.write(`[mcp] ${mcp.tools.length} tool(s) from ${mcp.records.length} server(s)\n`);
}
const systemPrompt = await resolveSystemPrompt();
const runtime = new LocalRuntimeHost(process.cwd());
const planMode = new PlanModeController();
// Plan mode wraps the interactive handler so an active plan denies every
// state-changing tool, regardless of what the user approves per call.
const session = createAgentSession({
  provider,
  workingDirectory: process.cwd(),
  tools: [
    ...createBuiltinTools(runtime),
    ...createWebTools(),
    ...createPlanModeTools(planMode),
    createAskUserQuestionTool(new InteractiveCliQuestionHandler()),
    // Remote tools last, and already namespaced `mcp__<server>__<tool>`, so a
    // stored server cannot shadow a builtin.
    ...mcp.tools,
  ],
  permissionHandler: new PlanModePermissionHandler(planMode, new InteractiveCliPermissionHandler()),
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

const failed = await streamSessionToStdout(session, prompt);

await session.close();
await mcp.close();
await closeModelProvider();
if (failed) process.exitCode = 1;

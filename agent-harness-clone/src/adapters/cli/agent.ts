#!/usr/bin/env node
/**
 * Runs one stored agent.
 *
 *   npm run agent:run -- 'Review the ABAP object ZCL_ORDER'
 *   npm run agent:run -- --agent sap-abap-assistant 'Review ZCL_ORDER'
 *   npm run agent:run -- --list
 *
 * Everything about the run except the prompt comes from the `agents` record: the
 * system prompt, which tools the session may call, the inline skills, which
 * `model_providers` record supplies the model and credential, which `mcp_servers`
 * records are connected, and the turn and token ceilings.
 *
 * No variable can change any of that, and none can pick the agent either. With no
 * `--agent`, the record marked `isDefault` runs. `AGENT_MAX_TURNS` is deliberately
 * not read here: the record's `limits.maxTurns` is the only ceiling.
 */
import { MongoClient } from 'mongodb';
import { createAgentSession } from '../../core/agent-session.js';
import { errorMessage } from '../../core/errors.js';
import { PlanModePermissionHandler } from '../../permissions/plan-mode-permission-handler.js';
import {
  agentConfigFromEnvironment,
  resolveAgentFromDatabase,
} from '../../platform/agent-resolution.js';
import { MongoAgentStore } from '../../platform/agent-store.js';
import { MongoMcpServerStore } from '../../platform/mcp-server-store.js';
import { MongoSkillStore } from '../../platform/skill-store.js';
import {
  MongoModelProviderStore,
  PLATFORM_MONGO_APP_NAME,
} from '../../platform/model-provider-store.js';
import { LocalRuntimeHost } from '../../runtime/local-runtime-host.js';
import { createBuiltinTools } from '../../tools/builtin/index.js';
import { createAskUserQuestionTool } from '../../tools/interactive/ask-user-question.js';
import { createPlanModeTools, PlanModeController } from '../../tools/planning/plan-mode.js';
import { createWebTools } from '../../tools/web/index.js';
import { InteractiveCliPermissionHandler } from './interactive-permissions.js';
import { InteractiveCliQuestionHandler } from './interactive-questions.js';
import { streamSessionToStdout } from './stream-events.js';

const { agentName, prompt, list } = parseArguments(process.argv.slice(2));

if (list) {
  await listAgents();
  process.exit(0);
}
if (!prompt) {
  process.stderr.write(
    'usage: npm run agent:run -- [--agent <name>] <prompt>\n' +
      '       npm run agent:run -- --list\n',
  );
  process.exit(2);
}

const runtime = new LocalRuntimeHost(process.cwd());
const planMode = new PlanModeController();
// Every tool this host can offer. The record names the subset it wants, and a
// name the host does not offer is reported rather than dropped, so a prompt
// cannot silently lose the tool it relies on.
const localTools = [
  ...createBuiltinTools(runtime),
  ...createWebTools(),
  ...createPlanModeTools(planMode),
  createAskUserQuestionTool(new InteractiveCliQuestionHandler()),
];

const agent = await resolveAgentFromDatabase(undefined, {
  ...(agentName === undefined ? {} : { agentName }),
  localTools,
  logger: (message) => process.stderr.write(`${message}\n`),
});

process.stderr.write(
  `[agent] ${agent.record.name} -> ${agent.modelProvider.name} ` +
    `${agent.model ?? agent.modelProvider.model} ` +
    `(maxTurns=${agent.limits.maxTurns}, maxInputTokens=${agent.limits.maxInputTokens}, ` +
    `maxOutputTokens=${agent.limits.maxOutputTokens})\n`,
);
for (const record of agent.mcpRecords) {
  const target = record.transport === 'stdio' ? record.command : record.url;
  process.stderr.write(`[mcp] ${record.name} -> ${record.transport} ${target ?? ''}\n`);
}
process.stderr.write(
  `[tools] ${agent.tools.map((tool) => tool.name).join(', ') || 'none'}\n` +
    `[skills] ${agent.skillRecords.map((skill) => skill.name).join(', ') || 'none'}\n`,
);
if (agent.skillRecords.length > 0) {
  process.stderr.write(`[skills] downloaded to ${agent.skillDirectory}, removed on exit\n`);
}

// Plan mode wraps the interactive handler so an active plan denies every
// state-changing tool, regardless of what the user approves per call.
const session = createAgentSession({
  provider: agent.provider,
  workingDirectory: process.cwd(),
  tools: agent.tools,
  permissionHandler: new PlanModePermissionHandler(planMode, new InteractiveCliPermissionHandler()),
  systemPrompt: agent.systemPrompt,
  ...(agent.model === undefined ? {} : { model: agent.model }),
  limits: agent.limits,
});

// `finally`, so an interrupted or failed run still takes the skill files with it:
// they are instructions written to a shared temporary directory and should not
// outlive the command that needed them.
let failed = false;
try {
  failed = await streamSessionToStdout(session, prompt);
} finally {
  await session.close();
  await agent.close();
}
if (failed) process.exitCode = 1;

/**
 * `--agent <name>` selects the record; everything else joins to form the prompt,
 * so a prompt needs no quoting beyond what the shell requires.
 */
function parseArguments(argv: readonly string[]): {
  agentName?: string;
  prompt: string;
  list: boolean;
} {
  const words: string[] = [];
  let agentName: string | undefined;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--list') {
      list = true;
      continue;
    }
    if (argument === '--agent' || argument === '-a') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires an agent name`);
      }
      agentName = value;
      index += 1;
      continue;
    }
    words.push(argument);
  }
  return {
    ...(agentName === undefined ? {} : { agentName }),
    prompt: words.join(' ').trim(),
    list,
  };
}

/**
 * Reads the three collections directly: listing needs no model client and no MCP
 * connection, only the names behind each record's references. A reference whose
 * target is gone prints as missing rather than failing the whole listing, since
 * seeing which agent is broken is the point of asking.
 */
async function listAgents(): Promise<void> {
  const config = agentConfigFromEnvironment();
  const client = new MongoClient(config.uri, { appName: PLATFORM_MONGO_APP_NAME });
  await client.connect();
  try {
    const agents = new MongoAgentStore({ client, databaseName: config.databaseName });
    const providers = new MongoModelProviderStore({
      client,
      databaseName: config.databaseName,
    });
    const skills = new MongoSkillStore({ client, databaseName: config.databaseName });
    const servers = new MongoMcpServerStore({ client, databaseName: config.databaseName });
    const records = await agents.list();
    if (records.length === 0) {
      process.stderr.write(
        `${config.databaseName}.agents is empty. Add a record with npx tsx scripts/agent/seedAgent.ts.\n`,
      );
      return;
    }
    for (const record of records) {
      const provider = await providers.get(record.modelProviderId);
      const mcpNames: string[] = [];
      for (const id of record.mcpServerIds) {
        mcpNames.push((await servers.get(id))?.name ?? `<missing ${id}>`);
      }
      const skillNames: string[] = [];
      for (const entry of record.skills) {
        skillNames.push((await skills.get(entry.skillId))?.name ?? `<missing ${entry.skillId}>`);
      }
      // The prompt's length is shown rather than the prompt: a listing should stay
      // one line per agent however long the prompts are.
      process.stdout.write(
        `${record.name}${record.isDefault ? ' (default)' : ''}` +
          `${record.enabled ? '' : ' [disabled]'} -> ` +
          `${provider?.name ?? `<missing ${record.modelProviderId}>`}` +
          `${record.model ? ` (${record.model})` : ''}` +
          `${record.description ? ` - ${record.description}` : ''}\n` +
          `  prompt ${record.systemPrompt.length} chars, ` +
          `${record.tools.length} tool(s), skills: ${skillNames.join(', ') || 'none'}, ` +
          `mcp: ${mcpNames.join(', ') || 'none'}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

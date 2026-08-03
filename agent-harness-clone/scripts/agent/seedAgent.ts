#!/usr/bin/env node
/**
 * Adds new `agents` records. Edit the variables below, then run:
 *
 *   npx tsx scripts/agent/seedAgent.ts
 *
 * This talks to MongoDB directly. It only inserts: a name that already exists is
 * refused, so a run can never overwrite a record by accident. Use `editAgent.ts`
 * to change an existing one and `deleteAgent.js` to remove one.
 *
 * The document shape must match the strict schema in
 * `src/platform/agent-definitions.ts`, so do not add fields.
 *
 * An agent stores no credential. It references `model_providers`, `skills`, and
 * `mcp_servers` records by their `_id`, and you name them here: the script resolves
 * each name to an `_id` and refuses anything that does not exist.
 *
 * The system prompt is stored in MongoDB. Give it inline as `systemPrompt`, or point
 * `systemPromptFile` at a local Markdown file to author it as a file and have its
 * text stored — the file is read at seed time and not needed afterwards. Skill
 * bodies are the ones that live in the content bucket; add those with
 * `node scripts/skill/seedSkill.js`.
 */
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { errorMessage } from '../../src/core/errors.js';
import { MongoSkillStore } from '../../src/platform/skill-store.js';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * One entry per agent to add. At most one entry should set `isDefault: true`:
 * that is the record `npm run agent:run` picks when no `--agent <name>` is given,
 * and it takes the default away from whichever record holds it now. An agent is
 * selected, not composed, so exactly one runs.
 *
 * `modelProvider` is the `name` of a `model_providers` record; add it with
 * `scripts/model/seedModel.js` first. `model` is optional and overrides the model id
 * on that record for this agent only.
 *
 * Set exactly one of `systemPrompt` and `systemPromptFile`.
 *
 * `tools` names local tools. Supported: read_file, glob, grep, write_file,
 * edit_file, bash, powershell, todo_write, web_search, web_fetch, enter_plan_mode,
 * exit_plan_mode, ask_user_question. Do not list `skill` or any `mcp__*` name: the
 * first is built from `skills` and the second is generated when a server answers
 * listTools.
 *
 * `skills` are `name` values from the `skills` collection, added with
 * `node scripts/skill/seedSkill.js`. Give a plain string to inherit the skill's own
 * `allowedTools`, or `{ skill, allowedTools }` to narrow them for this agent. Whichever
 * list applies must be a subset of this agent's `tools`; an inherited one is checked
 * when the agent resolves, since it is in the skill's document rather than in MongoDB.
 *
 * `mcpServers` are `name` values from `mcp_servers`, connected for this agent only.
 * This list is the whole selection: `autoConnect` is not consulted for an agent run.
 *
 * `maxTurns` is required. `maxOutputTokens` and `maxInputTokens` are optional and
 * may only narrow what the model provider record allows.
 */
const AGENTS = [
  {
    name: 'sap-abap-assistant',
    description: 'Reads and edits ABAP objects over the local ADT MCP server',
    modelProvider: 'NVIDIA Model',
    model: undefined as string | undefined,
    systemPrompt:
      'You are an SAP ABAP engineer. Read the object before changing it, keep changes ' +
      'minimal, and explain the transport impact of anything you write.',
    systemPromptFile: undefined as string | undefined,
    tools: ['read_file', 'glob', 'grep', 'edit_file', 'todo_write'],
    skills: ['abap-review'] as Array<string | { skill: string; allowedTools?: string[] }>,
    mcpServers: ['abap-adt-api-local'],
    maxTurns: 24,
    maxOutputTokens: undefined as number | undefined,
    maxInputTokens: undefined as number | undefined,
    isDefault: true,
  },
];

// --- nothing below needs editing -------------------------------------------

const SUPPORTED_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'bash',
  'powershell',
  'todo_write',
  'web_search',
  'web_fetch',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
];

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const database = client.db();
const agents = database.collection('agents');
const providers = database.collection('model_providers');
const servers = database.collection('mcp_servers');
const skillStore = new MongoSkillStore({ client, databaseName: database.databaseName });

try {
  // `_id` needs no index here: MongoDB creates a unique one for it.
  await Promise.all([
    agents.createIndex({ name: 1 }, { unique: true }),
    agents.createIndex({ enabled: 1 }),
  ]);

  for (const entry of AGENTS) {
    if (await agents.findOne({ name: entry.name })) {
      throw new Error(
        `${entry.name}: a record with this name already exists. Use editAgent.ts to change it, ` +
          'or deleteAgent.js to remove it first.',
      );
    }

    const systemPrompt = await resolvePrompt(entry);

    // Each name is resolved to the `_id` that gets stored, so the reference survives
    // a later rename and a wrong name never reaches the collection.
    const provider = await providers.findOne({ name: entry.modelProvider });
    if (!provider) {
      throw new Error(
        `${entry.name}: modelProvider '${entry.modelProvider}' is not in model_providers. ` +
          'Add it with scripts/model/seedModel.js first.',
      );
    }

    const tools = entry.tools ?? [];
    for (const tool of tools) {
      if (!SUPPORTED_TOOLS.includes(tool)) {
        throw new Error(
          `${entry.name}: tool '${tool}' does not exist in this runtime. ` +
            `Supported: ${SUPPORTED_TOOLS.join(', ')}.`,
        );
      }
    }
    assertUnique(entry.name, tools, 'tools');

    const skills = [];
    const skillNames: string[] = [];
    for (const reference of entry.skills ?? []) {
      const name = typeof reference === 'string' ? reference : reference.skill;
      const override = typeof reference === 'string' ? undefined : reference.allowedTools;
      const skill = await skillStore.getByName(name);
      if (!skill) {
        throw new Error(
          `${entry.name}: skills names '${name}', which is not in the skills collection. ` +
            'Add it with node scripts/skill/seedSkill.js first.',
        );
      }
      const id = skill._id.toHexString();
      if (skills.some((existing) => existing.skillId === id)) {
        throw new Error(
          `${entry.name}: duplicate skills entry '${name}': it would resolve once either way`,
        );
      }
      // Only the override can be checked here. A skill's own allowedTools are in its
      // document in the bucket, so resolution is what catches those, failing with
      // SKILL_TOOL_NOT_AVAILABLE.
      for (const tool of override ?? []) {
        if (tools.includes(tool)) continue;
        throw new Error(
          `${entry.name}: skill '${name}' overrides allowedTools with '${tool}', which is not ` +
            "in the agent's tools. Add it to tools, or drop it from the override.",
        );
      }
      skills.push({ skillId: id, ...(override?.length ? { allowedTools: override } : {}) });
      skillNames.push(name);
    }

    const mcpServerIds: string[] = [];
    for (const name of entry.mcpServers ?? []) {
      const server = await servers.findOne({ name });
      if (!server) {
        throw new Error(
          `${entry.name}: mcpServers names '${name}', which is not in mcp_servers. ` +
            'Add it with scripts/mcp/seedMcp.js first.',
        );
      }
      const id = server._id.toHexString();
      if (mcpServerIds.includes(id)) {
        throw new Error(
          `${entry.name}: duplicate mcpServers entry '${name}': it would resolve once either way`,
        );
      }
      mcpServerIds.push(id);
    }

    // Both ceilings may only narrow what the model provider record allows.
    const maxOutputTokens = entry.maxOutputTokens ?? provider.capabilities.maxOutputTokens;
    const maxInputTokens =
      entry.maxInputTokens ?? provider.capabilities.contextWindow - maxOutputTokens;
    if (maxOutputTokens > provider.capabilities.maxOutputTokens) {
      throw new Error(
        `${entry.name}: maxOutputTokens (${maxOutputTokens}) is above the ` +
          `${provider.capabilities.maxOutputTokens} that '${provider.name}' allows`,
      );
    }
    if (maxInputTokens + maxOutputTokens > provider.capabilities.contextWindow) {
      throw new Error(
        `${entry.name}: maxInputTokens (${maxInputTokens}) plus maxOutputTokens ` +
          `(${maxOutputTokens}) is above the ${provider.capabilities.contextWindow} context ` +
          `window of '${provider.name}'`,
      );
    }

    const now = new Date().toISOString();
    // No id field: MongoDB assigns `_id` on insert and that is the record's id.
    const document = {
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      systemPrompt,
      modelProviderId: provider._id.toHexString(),
      ...(entry.model ? { model: entry.model } : {}),
      tools,
      skills,
      mcpServerIds,
      limits: {
        maxTurns: entry.maxTurns,
        ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
        ...(entry.maxInputTokens === undefined ? {} : { maxInputTokens: entry.maxInputTokens }),
      },
      enabled: true,
      isDefault: entry.isDefault === true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'operator',
    };

    // At most one default, matching what the runtime expects to find.
    if (document.isDefault) {
      await agents.updateMany({ isDefault: true }, { $set: { isDefault: false, updatedAt: now } });
    }
    const result = await agents.insertOne(document);

    console.log(
      `inserted ${document.name} -> model ${provider.name} (${document.modelProviderId})` +
        `${document.model ? ` overriding model as ${document.model}` : ''}\n` +
        `  prompt ${systemPrompt.length} chars, tools=${tools.length}, ` +
        `skills=${skillNames.join(', ') || 'none'}, ` +
        `mcpServers=${(entry.mcpServers ?? []).join(', ') || 'none'}\n` +
        `  maxTurns=${document.limits.maxTurns}, maxInputTokens=${maxInputTokens}, ` +
        `maxOutputTokens=${maxOutputTokens}, default=${document.isDefault}, ` +
        `_id=${result.insertedId.toHexString()}`,
    );
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  await client.close();
}

/**
 * The prompt is stored in the record either way; the file is only an authoring
 * convenience, so it is read here and never consulted again.
 */
async function resolvePrompt(entry: {
  name: string;
  systemPrompt?: string | undefined;
  systemPromptFile?: string | undefined;
}): Promise<string> {
  const inline = entry.systemPrompt?.trim();
  const file = entry.systemPromptFile?.trim();
  if (inline && file) {
    throw new Error(
      `${entry.name}: set systemPrompt or systemPromptFile, not both. Two sources for one value ` +
        'would leave which one is stored a matter of reading this script.',
    );
  }
  if (inline) return inline;
  if (!file) throw new Error(`${entry.name}: systemPrompt or systemPromptFile is required`);
  const text = (await readFile(file, 'utf8')).trim();
  if (text === '') throw new Error(`${entry.name}: ${file} is empty`);
  return text;
}

function assertUnique(agentName: string, values: readonly string[], field: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `${agentName}: duplicate ${field} entry '${duplicate}': it would resolve once either way`,
    );
  }
}

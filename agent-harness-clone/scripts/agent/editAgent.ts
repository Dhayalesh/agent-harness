#!/usr/bin/env node
/**
 * Edits one existing `agents` record. Edit the variables below, then run:
 *
 *   npx tsx scripts/agent/editAgent.ts
 *
 * This talks to MongoDB directly and finds the record by `_id`. It only updates: an
 * id that does not exist is refused, so a typo cannot silently create a second
 * record. Use `seedAgent.ts` to add one and `deleteAgent.js` to remove one.
 *
 * The record keeps its `_id` and `createdAt`. Only the fields set in `CHANGES` are
 * touched, and the whole merged document is checked before it is written.
 *
 * A list field is replaced, not merged: setting `tools` gives the agent exactly
 * those tools, so read the record first if you mean to add one.
 *
 * `modelProvider`, `skills`, and `mcpServers` are given as `name` values and stored
 * as `_id`s. The system prompt is stored in the record; set `systemPrompt` inline or
 * point `systemPromptFile` at a local Markdown file to replace it.
 */
import { readFile } from 'node:fs/promises';
import { MongoClient, ObjectId } from 'mongodb';
import { errorMessage } from '../../src/core/errors.js';
import { MongoSkillStore } from '../../src/platform/skill-store.js';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to edit, as the 24-character hex string MongoDB shows.
 * `seedAgent.ts` prints the `_id` when it inserts a record.
 */
const AGENT_ID = '6a68eb69acab70f9ed8ce811';

/** Only the fields to change. Delete or comment out the lines to leave alone. */
const CHANGES: {
  name?: string;
  description?: string;
  modelProvider?: string;
  model?: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  tools?: string[];
  skills?: Array<string | { skill: string; allowedTools?: string[] }>;
  mcpServers?: string[];
  maxTurns?: number;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  enabled?: boolean;
  isDefault?: boolean;
} = {
  // name: 'sap-abap-reviewer', // renames the record
  // description: 'Reviews ABAP changes without editing them',
  // modelProvider: 'NVIDIA Model', // name from model_providers; stored as its _id
  // model: 'zai.glm-5', // overrides the provider record's model; '' clears it
  // systemPrompt: 'You are an SAP ABAP reviewer...',
  // systemPromptFile: 'prompts/sap-abap-reviewer.md',
  // tools: ['read_file', 'grep'], // replaces the list
  // skills: ['abap-review'], // names from the skills collection; replaces the list
  // skills: [{ skill: 'abap-review', allowedTools: ['read_file'] }], // with override
  // mcpServers: ['abap-adt-api-local'], // names from mcp_servers; replaces the list
  // maxTurns: 24,
  // maxOutputTokens: 32000,
  // maxInputTokens: 224000,
  // enabled: true,
  // isDefault: true,
};

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
  const existing = await agents.findOne({ _id: new ObjectId(AGENT_ID) });
  if (!existing) {
    throw new Error(`${AGENT_ID}: no record with this _id. Use seedAgent.ts to add it.`);
  }
  if (Object.keys(CHANGES).length === 0) {
    throw new Error('CHANGES is empty: set at least one field to edit');
  }
  if (CHANGES.systemPrompt !== undefined && CHANGES.systemPromptFile !== undefined) {
    throw new Error('set systemPrompt or systemPromptFile, not both');
  }

  const now = new Date().toISOString();
  // `_id` carries over untouched: it is the record's identity, not a field.
  const merged: Record<string, unknown> = { ...existing, updatedAt: now };
  for (const field of ['name', 'description', 'model', 'tools', 'enabled', 'isDefault'] as const) {
    if (CHANGES[field] !== undefined) merged[field] = CHANGES[field];
  }
  const limits = merged.limits as Record<string, number>;
  for (const field of ['maxTurns', 'maxOutputTokens', 'maxInputTokens'] as const) {
    if (CHANGES[field] !== undefined) limits[field] = CHANGES[field] as number;
  }
  // An empty string clears the override rather than storing a model with no id.
  if (CHANGES.model === '') delete merged.model;

  if (CHANGES.systemPrompt !== undefined) {
    const text = CHANGES.systemPrompt.trim();
    if (text === '') throw new Error(`${merged.name}: systemPrompt cannot be empty`);
    merged.systemPrompt = text;
  }
  if (CHANGES.systemPromptFile !== undefined) {
    const text = (await readFile(CHANGES.systemPromptFile, 'utf8')).trim();
    if (text === '') throw new Error(`${merged.name}: ${CHANGES.systemPromptFile} is empty`);
    merged.systemPrompt = text;
  }

  if (CHANGES.modelProvider !== undefined) {
    const target = await providers.findOne({ name: CHANGES.modelProvider });
    if (!target) {
      throw new Error(
        `${merged.name}: modelProvider '${CHANGES.modelProvider}' is not in model_providers`,
      );
    }
    merged.modelProviderId = target._id.toHexString();
  }
  if (CHANGES.mcpServers !== undefined) {
    const ids: string[] = [];
    for (const name of CHANGES.mcpServers) {
      const target = await servers.findOne({ name });
      if (!target) {
        throw new Error(`${merged.name}: mcpServers names '${name}', which is not in mcp_servers`);
      }
      const id = target._id.toHexString();
      if (ids.includes(id)) {
        throw new Error(`${merged.name}: duplicate mcpServers entry '${name}'`);
      }
      ids.push(id);
    }
    merged.mcpServerIds = ids;
  }

  const tools = (merged.tools as string[]) ?? [];
  for (const tool of tools) {
    if (!SUPPORTED_TOOLS.includes(tool)) {
      throw new Error(
        `${merged.name}: tool '${tool}' does not exist in this runtime. ` +
          `Supported: ${SUPPORTED_TOOLS.join(', ')}.`,
      );
    }
  }
  assertUnique(merged.name as string, tools, 'tools');

  if (CHANGES.skills !== undefined) {
    const entries = [];
    for (const reference of CHANGES.skills) {
      const name = typeof reference === 'string' ? reference : reference.skill;
      const override = typeof reference === 'string' ? undefined : reference.allowedTools;
      const skill = await skillStore.getByName(name);
      if (!skill) {
        throw new Error(
          `${merged.name}: skills names '${name}', which is not in the skills collection`,
        );
      }
      const id = skill._id.toHexString();
      if (entries.some((current) => current.skillId === id)) {
        throw new Error(`${merged.name}: duplicate skills entry '${name}'`);
      }
      entries.push({ skillId: id, ...(override?.length ? { allowedTools: override } : {}) });
    }
    merged.skills = entries;
  }

  // Every skill on the merged record is re-checked against the merged tools, since
  // narrowing tools can invalidate a skill this edit did not touch. Only the overrides
  // can be checked here: a skill's own allowedTools live in its document in the bucket,
  // so resolution is what catches those, with SKILL_TOOL_NOT_AVAILABLE.
  const skillEntries = (merged.skills as Array<{ skillId: string; allowedTools?: string[] }>) ?? [];
  const skillNames: string[] = [];
  for (const entry of skillEntries) {
    const skill = await skillStore.get(entry.skillId);
    if (!skill) {
      throw new Error(`${merged.name}: skillId ${entry.skillId} is no longer in skills`);
    }
    for (const tool of entry.allowedTools ?? []) {
      if (tools.includes(tool)) continue;
      throw new Error(
        `${merged.name}: skill '${skill.name}' overrides allowedTools with '${tool}', which is ` +
          "not in the agent's tools. Add it to tools, or drop it from the override.",
      );
    }
    skillNames.push(skill.name);
  }

  const provider = await providers.findOne({
    _id: new ObjectId(merged.modelProviderId as string),
  });
  if (!provider) {
    throw new Error(
      `${merged.name}: modelProviderId ${merged.modelProviderId} is no longer in model_providers`,
    );
  }
  for (const id of (merged.mcpServerIds as string[]) ?? []) {
    if (!(await servers.findOne({ _id: new ObjectId(id) }))) {
      throw new Error(`${merged.name}: mcpServerIds ${id} is no longer in mcp_servers`);
    }
  }

  // Both ceilings may only narrow what the model provider record allows.
  const maxOutputTokens = limits.maxOutputTokens ?? provider.capabilities.maxOutputTokens;
  const maxInputTokens =
    limits.maxInputTokens ?? provider.capabilities.contextWindow - maxOutputTokens;
  if (maxOutputTokens > provider.capabilities.maxOutputTokens) {
    throw new Error(
      `${merged.name}: maxOutputTokens (${maxOutputTokens}) is above the ` +
        `${provider.capabilities.maxOutputTokens} that '${provider.name}' allows`,
    );
  }
  if (maxInputTokens + maxOutputTokens > provider.capabilities.contextWindow) {
    throw new Error(
      `${merged.name}: maxInputTokens (${maxInputTokens}) plus maxOutputTokens ` +
        `(${maxOutputTokens}) is above the ${provider.capabilities.contextWindow} context ` +
        `window of '${provider.name}'`,
    );
  }

  if (merged.name !== existing.name && (await agents.findOne({ name: merged.name }))) {
    throw new Error(`${merged.name}: a record with this name already exists`);
  }
  // At most one default, matching what the runtime expects to find.
  if (merged.isDefault === true) {
    await agents.updateMany(
      { isDefault: true, _id: { $ne: merged._id } },
      { $set: { isDefault: false, updatedAt: now } },
    );
  }

  await agents.replaceOne({ _id: merged._id as ObjectId }, merged);

  console.log(
    `updated ${existing.name}${merged.name === existing.name ? '' : ` -> ${merged.name}`} ` +
      `(${Object.keys(CHANGES).join(', ')})\n` +
      `  model ${provider.name} (${merged.modelProviderId})` +
      `${merged.model ? ` overriding model as ${merged.model}` : ''}\n` +
      `  prompt ${(merged.systemPrompt as string).length} chars, tools=${tools.length}, ` +
      `skills=${skillNames.join(', ') || 'none'}, ` +
      `mcpServers=${((merged.mcpServerIds as string[]) ?? []).length}\n` +
      `  maxTurns=${limits.maxTurns}, maxInputTokens=${maxInputTokens}, ` +
      `maxOutputTokens=${maxOutputTokens}, enabled=${merged.enabled}, ` +
      `default=${merged.isDefault === true}`,
  );
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
} finally {
  await client.close();
}

function assertUnique(agentName: string, values: readonly string[], field: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) {
    throw new Error(
      `${agentName}: duplicate ${field} entry '${duplicate}': it would resolve once either way`,
    );
  }
}

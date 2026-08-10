#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { parseS3Uri } from '../../src/content/s3-uri.js';
import type { InvocationPayloadInput } from '../../src/headless/payload.js';

/**
 * Converts an agent stored by a previous version of this project into a payload file.
 *
 * A one-way migration aid, and the only thing left in the repository that opens a
 * database. It exists because the runtime no longer reads the `agents`,
 * `model_providers`, `mcp_servers`, and `skills` collections, and an operator with
 * records in them needs a way out that does not involve retyping a system prompt and
 * a set of credentials by hand.
 *
 * It is deliberately standalone: it talks to the driver directly rather than through
 * `src/`, so deleting it later removes the last MongoDB dependency in one step and
 * nothing in `src/` has to keep a store class alive for it.
 *
 * Usage:
 *   npm run export-payload -- [--agent <name>] [--out payload.json] [--prompt "..."]
 *
 * The output file carries the model credential and every MCP credential the agent
 * references, in cleartext, because that is what a payload is. Treat it like a `.env`:
 * it is gitignored by default and should not be committed, pasted, or left in a shared
 * directory.
 */

type StoredAgent = {
  name: string;
  description?: string;
  systemPrompt: string;
  modelProviderId: string;
  model?: string;
  tools: string[];
  skills: Array<{ skillId: string; allowedTools?: string[] }>;
  mcpServerIds: string[];
  limits: { maxTurns: number; maxOutputTokens?: number; maxInputTokens?: number };
  isDefault?: boolean;
};

const options = parseArguments(process.argv.slice(2));
const uri = process.env.PLATFORM_MONGODB_URI?.trim();
if (!uri) {
  throw new Error(
    'PLATFORM_MONGODB_URI is required to read the old collections. Set it in .env. The runtime ' +
      'itself never opens a database; only this migration script does.',
  );
}

const client = new MongoClient(uri, { appName: 'agent-harness-export' });
await client.connect();

try {
  const db = client.db();
  const agent = (await db
    .collection('agents')
    .findOne(
      options.agent === undefined ? { enabled: true, isDefault: true } : { name: options.agent },
    )) as (StoredAgent & Document) | null;
  if (!agent) {
    throw new Error(
      options.agent === undefined
        ? `No enabled record marked isDefault in ${db.databaseName}.agents`
        : `No agent named '${options.agent}' in ${db.databaseName}.agents`,
    );
  }

  const provider = await byId(db, 'model_providers', agent.modelProviderId);
  const mcpServers = [];
  for (const id of agent.mcpServerIds ?? []) {
    mcpServers.push(await byId(db, 'mcp_servers', id));
  }

  // The payload carries only each skill's address. The runtime reads the object with
  // its own AWS role and materializes it only for the duration of the run.
  const skills = [];
  for (const entry of agent.skills ?? []) {
    const record = await byId(db, 'skills', entry.skillId);
    const skillName = String(record.name);
    const skillUri = String(record.uri);
    parseS3Uri(skillUri, `skill '${skillName}'`);
    skills.push({
      name: skillName,
      uri: skillUri,
      ...(entry.allowedTools === undefined ? {} : { allowedTools: [...entry.allowedTools] }),
    });
  }

  const payload: InvocationPayloadInput = {
    prompt: options.prompt,
    agent: {
      name: agent.name,
      ...(agent.description === undefined ? {} : { description: agent.description }),
      systemPrompt: agent.systemPrompt,
      ...(agent.model === undefined ? {} : { model: agent.model }),
      tools: [...(agent.tools ?? [])],
      limits: agent.limits,
    },
    modelProvider: pick(provider, [
      'name',
      'provider',
      'model',
      'baseURL',
      'apiKey',
      'auth',
      'capabilities',
      'wire',
      'headers',
    ]) as InvocationPayloadInput['modelProvider'],
    mcpServers: mcpServers.map(
      (server) =>
        pick(server, [
          'name',
          'transport',
          'command',
          'args',
          'env',
          'url',
          'apiKey',
          'auth',
          'capabilities',
          'wire',
          'headers',
        ]) as NonNullable<InvocationPayloadInput['mcpServers']>[number],
    ),
    skills,
    // Every tool the record names, allowed. The stored agent already ran with these, so
    // a payload that denied them would not be the same agent.
    permissionRules: [
      ...(agent.tools ?? []).map((tool) => ({ tool, decision: 'allow' as const })),
      ...(skills.length === 0 ? [] : [{ tool: 'skill', decision: 'allow' as const }]),
      ...(mcpServers.length === 0 ? [] : [{ tool: 'mcp__*', decision: 'allow' as const }]),
    ],
    permissionFallback: 'deny',
  };

  const out = path.resolve(options.out);
  await writeFile(out, `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8');
  process.stdout.write(
    [
      `Exported agent '${agent.name}' to ${out}`,
      `  modelProvider: ${String(provider.name)} (${String(provider.provider)}, ${String(provider.model)})`,
      `  tools:         ${(agent.tools ?? []).join(', ') || 'none'}`,
      `  mcpServers:    ${mcpServers.map((s) => String(s.name)).join(', ') || 'none'}`,
      `  skills:        ${skills.map((s) => s.name).join(', ') || 'none'}`,
      '',
      'This file contains the model and MCP credentials in cleartext. Do not commit it.',
      '',
      `Run it:  npm run payload -- ${path.relative(process.cwd(), out)}`,
      '',
    ].join('\n'),
  );
} finally {
  await client.close();
}

/** Reads one referenced record, failing with the collection and the id that was missing. */
async function byId(
  db: ReturnType<MongoClient['db']>,
  collection: string,
  id: string,
): Promise<Document> {
  const found = await db.collection(collection).findOne({ _id: new ObjectId(id) });
  if (!found) throw new Error(`${collection} has no record ${id}, which the agent references`);
  return found;
}

/**
 * Copies the named fields when present, dropping `_id` and the provenance fields the
 * payload schema does not accept. Absent stays absent rather than becoming `undefined`,
 * because the schema is strict and a present-but-undefined key reads as a set value.
 */
function pick(source: Document, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) result[field] = source[field];
  }
  return result;
}

function parseArguments(argv: readonly string[]): {
  agent?: string;
  out: string;
  prompt: string;
} {
  let agent: string | undefined;
  let out = 'payload.json';
  let prompt = 'Introduce yourself in one sentence, then stop.';
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--agent' && value) {
      agent = value;
      index += 1;
    } else if (flag === '--out' && value) {
      out = value;
      index += 1;
    } else if (flag === '--prompt' && value) {
      prompt = value;
      index += 1;
    } else {
      throw new Error(
        `Unrecognised argument: ${flag}. Usage: exportPayload.ts [--agent <name>] ` +
          '[--out payload.json] [--prompt "..."]',
      );
    }
  }
  return { ...(agent === undefined ? {} : { agent }), out, prompt };
}

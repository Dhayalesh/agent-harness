#!/usr/bin/env node
/**
 * Adds new `mcp_servers` records. Edit the variables below, then run:
 *
 *   node scripts/mcp/seedMcp.js
 *
 * This talks to MongoDB directly. It only inserts: a name that already exists is
 * refused, so a run can never overwrite a record by accident. Use `editMcp.js` to
 * change an existing one and `deleteMcp.js` to remove one.
 *
 * The document shape must match the strict schema in
 * `src/platform/mcp-server-definitions.ts`, so do not add fields.
 * A stdio record names a command this machine will execute, and an http record
 * stores the credential sent to its url. Do not commit a real `apiKey` value.
 */
import { MongoClient } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * One entry per MCP server to add. Unlike a model there is no single default:
 * every enabled entry with `autoConnect: true` is connected together. That flag
 * is the only switch, since a run takes its servers from this collection alone
 * and nothing in the environment can add or select one.
 *
 * A `stdio` entry needs `command` (plus optional `args`, `env`, `cwd`) and no
 * auth: a pipe carries no request to authenticate, so pass secrets through `env`.
 * An `http` entry needs `url`, and sends `apiKey` as `Authorization: Bearer`
 * unless `headerName` is set.
 *
 * `connectTimeoutMs` bounds the initialize handshake and `requestTimeoutMs`
 * bounds every call after it, including each tool call. Both are honoured at run
 * time. At least one of `tools`, `resources`, `prompts` must be true.
 */
const MCP_SERVERS = [
  {
    name: 'abap-adt-api-local',
    transport: 'stdio',
    command: 'node',
    args: ['C:\\Users\\bdhayalesh\\Desktop\\mcp\\mcp-abap-abap-adt-api\\dist\\index.js'],
    env: {
      SAP_URL: 'http://172.17.19.18:8000',
      SAP_USER: 'K4264',
      SAP_PASSWORD: 'KTern@6967',
      SAP_CLIENT: '210',
      SAP_LANGUAGE: 'EN',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    cwd: undefined,
    tools: true,
    resources: false,
    prompts: false,
    elicitation: false,
    connectTimeoutMs: 30000,
    requestTimeoutMs: 60000,
    autoConnect: true,
  },
];

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const servers = client.db().collection('mcp_servers');

try {
  // `_id` needs no index here: MongoDB creates a unique one for it.
  await Promise.all([
    servers.createIndex({ name: 1 }, { unique: true }),
    servers.createIndex({ enabled: 1, autoConnect: 1 }),
  ]);

  for (const entry of MCP_SERVERS) {
    if (await servers.findOne({ name: entry.name })) {
      throw new Error(
        `${entry.name}: a record with this name already exists. Use editMcp.js to ` +
          'change it, or deleteMcp.js to remove it first.',
      );
    }
    if (entry.transport !== 'stdio' && entry.transport !== 'http') {
      throw new Error(
        `${entry.name}: transport must be stdio or http, received '${entry.transport}'. ` +
          'sse has no client in this runtime.',
      );
    }
    if (!entry.tools && !entry.resources && !entry.prompts) {
      throw new Error(
        `${entry.name}: at least one of tools, resources, prompts must be true, or there is ` +
          'nothing to read from the server',
      );
    }
    if (entry.transport === 'stdio' && !(entry.command ?? '').trim()) {
      throw new Error(`${entry.name}: command is required for a stdio server`);
    }
    if (entry.transport === 'http' && !(entry.url ?? '').trim()) {
      throw new Error(`${entry.name}: url is required for an http server`);
    }
    if (entry.transport === 'http' && !(entry.apiKey ?? '').trim() && entry.headerName) {
      throw new Error(`${entry.name}: headerName is set, so apiKey is required`);
    }

    const authenticated = entry.transport === 'http' && (entry.apiKey ?? '').trim() !== '';
    const now = new Date().toISOString();
    // No id field: MongoDB assigns `_id` on insert and that is the record's id.
    const document = {
      name: entry.name,
      transport: entry.transport,
      ...(entry.transport === 'stdio'
        ? {
            command: entry.command.trim(),
            ...(entry.args?.length ? { args: entry.args } : {}),
            ...(Object.keys(entry.env ?? {}).length ? { env: entry.env } : {}),
          }
        : { url: entry.url.trim() }),
      ...(authenticated ? { apiKey: entry.apiKey.trim() } : {}),
      auth: authenticated
        ? entry.headerName
          ? { kind: 'header', headerName: entry.headerName }
          : { kind: 'bearer' }
        : { kind: 'none' },
      capabilities: {
        tools: entry.tools === true,
        resources: entry.resources === true,
        prompts: entry.prompts === true,
        elicitation: entry.elicitation === true,
        connectTimeoutMs: entry.connectTimeoutMs,
        requestTimeoutMs: entry.requestTimeoutMs,
      },
      ...(entry.transport === 'stdio' && entry.cwd ? { wire: { cwd: entry.cwd } } : {}),
      enabled: true,
      autoConnect: entry.autoConnect === true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'operator',
    };

    const result = await servers.insertOne(document);

    console.log(
      `inserted ${document.name} -> ${document.transport} ` +
        `${document.command ?? document.url} ` +
        `(tools=${document.capabilities.tools}, resources=${document.capabilities.resources}, ` +
        `prompts=${document.capabilities.prompts}, autoConnect=${document.autoConnect}, ` +
        `_id=${result.insertedId.toHexString()}` +
        `${authenticated ? ', apiKey stored, not printed' : ''})`,
    );
  }
} finally {
  await client.close();
}

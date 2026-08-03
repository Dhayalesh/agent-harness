#!/usr/bin/env node
/**
 * Edits one existing `mcp_servers` record. Edit the variables below, then run:
 *
 *   node scripts/mcp/editMcp.js
 *
 * This talks to MongoDB directly and finds the record by `_id`. It only updates:
 * an id that does not exist is refused, so a typo cannot silently create a second
 * record. Use `seedMcp.js` to add one and `deleteMcp.js` to remove one.
 *
 * The record keeps its `_id` and `createdAt`. Only the fields set in `CHANGES` are
 * touched, and the whole merged document is checked before it is written.
 * Do not commit a real `apiKey` value.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to edit, as the 24-character hex string MongoDB shows.
 * This is how the record is found, so a rename cannot point the edit at the wrong
 * document. `seedMcp.js` prints the `_id` when it inserts a record.
 */
const MCP_SERVER_ID = '6a68eb69acab70f9ed8ce811';

/**
 * Only the fields to change. Delete or comment out the lines to leave alone.
 * The merged record must still keep one transport's fields and not the other's:
 * a stdio record carries `command`/`args`/`env` and no auth, an http record
 * carries `url` and may carry `apiKey`.
 */
const CHANGES = {
  // name: 'filesystem-readonly', // renames the record
  // transport: 'stdio',
  // command: 'npx',
  // args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  // env: { EXAMPLE_TOKEN: '' },
  // url: 'https://mcp.example.com/mcp',
  // apiKey: '', // rotates the credential; http only
  // tools: true,
  // resources: false,
  // prompts: false,
  // elicitation: false,
  // connectTimeoutMs: 30000,
  // requestTimeoutMs: 60000,
  // enabled: true,
  // autoConnect: true,
};

// --- nothing below needs editing -------------------------------------------

const CAPABILITY_FIELDS = [
  'tools',
  'resources',
  'prompts',
  'elicitation',
  'connectTimeoutMs',
  'requestTimeoutMs',
];
const RECORD_FIELDS = [
  'name',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'apiKey',
  'enabled',
  'autoConnect',
];
const STDIO_ONLY = ['command', 'args', 'env'];
const HTTP_ONLY = ['url', 'apiKey'];

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const servers = client.db().collection('mcp_servers');

try {
  const existing = await servers.findOne({ _id: new ObjectId(MCP_SERVER_ID) });
  if (!existing) {
    throw new Error(`${MCP_SERVER_ID}: no record with this _id. Use seedMcp.js to add it.`);
  }

  const unknown = Object.keys(CHANGES).filter(
    (field) => !RECORD_FIELDS.includes(field) && !CAPABILITY_FIELDS.includes(field),
  );
  if (unknown.length > 0) {
    throw new Error(`unsupported field(s) in CHANGES: ${unknown.join(', ')}`);
  }
  if (Object.keys(CHANGES).length === 0) {
    throw new Error('CHANGES is empty: set at least one field to edit');
  }

  const now = new Date().toISOString();
  // `_id` carries over untouched: it is the record's identity, not a field.
  const merged = { ...existing, updatedAt: now };
  for (const field of RECORD_FIELDS) {
    if (CHANGES[field] !== undefined) merged[field] = CHANGES[field];
  }
  for (const field of CAPABILITY_FIELDS) {
    if (CHANGES[field] !== undefined) merged.capabilities[field] = CHANGES[field];
  }
  if (CHANGES.apiKey !== undefined) {
    if (!CHANGES.apiKey.trim()) {
      throw new Error(`${existing.name}: apiKey cannot be set to an empty value`);
    }
    merged.apiKey = CHANGES.apiKey.trim();
    // The credential and the header that carries it are one decision, so a
    // rotation onto a record with no auth would otherwise store an unused key.
    if (merged.auth.kind === 'none') merged.auth = { kind: 'bearer' };
  }

  // The transport decides which half of the record is meaningful, so the other
  // half is dropped rather than left behind reading as configured.
  const stale = merged.transport === 'stdio' ? HTTP_ONLY : STDIO_ONLY;
  for (const field of stale) delete merged[field];
  if (merged.transport === 'stdio') {
    merged.auth = { kind: 'none' };
    if (!(merged.command ?? '').trim()) {
      throw new Error(`${merged.name}: command is required for a stdio server`);
    }
  } else if (!(merged.url ?? '').trim()) {
    throw new Error(`${merged.name}: url is required for an ${merged.transport} server`);
  }
  if (merged.transport !== 'stdio' && merged.transport !== 'http') {
    throw new Error(
      `${merged.name}: transport must be stdio or http, received '${merged.transport}'`,
    );
  }
  if (
    !merged.capabilities.tools &&
    !merged.capabilities.resources &&
    !merged.capabilities.prompts
  ) {
    throw new Error(
      `${merged.name}: at least one of tools, resources, prompts must be true, or there is ` +
        'nothing to read from the server',
    );
  }
  if (merged.name !== existing.name && (await servers.findOne({ name: merged.name }))) {
    throw new Error(`${merged.name}: a record with this name already exists`);
  }

  await servers.replaceOne({ _id: merged._id }, merged);

  console.log(
    `updated ${existing.name}${merged.name === existing.name ? '' : ` -> ${merged.name}`} ` +
      `(${Object.keys(CHANGES).join(', ')}) -> ${merged.transport} ` +
      `${merged.command ?? merged.url} ` +
      `(tools=${merged.capabilities.tools}, resources=${merged.capabilities.resources}, ` +
      `prompts=${merged.capabilities.prompts}, enabled=${merged.enabled}, ` +
      `autoConnect=${merged.autoConnect === true}, ` +
      `apiKey=${CHANGES.apiKey === undefined ? 'unchanged' : 'rotated'}, not printed)`,
  );
} finally {
  await client.close();
}

#!/usr/bin/env node
/**
 * Deletes one `mcp_servers` record. Edit the variables below, then run:
 *
 *   node scripts/mcp/deleteMcp.js
 *
 * This talks to MongoDB directly and removes exactly one record, matched by `_id`.
 * An id that does not exist is refused rather than passing silently.
 *
 * Deleting an `autoConnect` record removes its tools from every later run without
 * failing one: MCP tools are additive, so the session simply has fewer of them.
 * The script says so when that happens.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to delete, as the 24-character hex string MongoDB
 * shows. `seedMcp.js` prints the `_id` when it inserts a record.
 */
const MCP_SERVER_ID = '6a68eb69acab70f9ed8ce811';

/** Safety catch: set to true to let the delete run. */
const CONFIRM = false;

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const servers = client.db().collection('mcp_servers');

try {
  const existing = await servers.findOne({ _id: new ObjectId(MCP_SERVER_ID) });
  if (!existing) {
    throw new Error(`${MCP_SERVER_ID}: no record with this _id, nothing to delete`);
  }
  if (!CONFIRM) {
    throw new Error(
      `${existing.name}: refusing to delete while CONFIRM is false. This would remove ` +
        `${existing.transport} ${existing.command ?? existing.url} ` +
        `(autoConnect=${existing.autoConnect === true})` +
        `${existing.apiKey ? ' and its stored credential' : ''}.`,
    );
  }

  await servers.deleteOne({ _id: existing._id });
  console.log(
    `deleted ${existing.name} -> ${existing.transport} ${existing.command ?? existing.url}`,
  );

  if (existing.autoConnect === true) {
    const remaining = await servers.countDocuments({ enabled: true, autoConnect: true });
    console.log(
      'that record was picked up automatically, so its tools leave every later run. ' +
        `${remaining} autoConnect record(s) remain. Add it back with seedMcp.js, or set ` +
        'autoConnect on another record with editMcp.js.',
    );
  }
} finally {
  await client.close();
}

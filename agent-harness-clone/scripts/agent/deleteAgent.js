#!/usr/bin/env node
/**
 * Deletes one `agents` record. Edit the variables below, then run:
 *
 *   node scripts/agent/deleteAgent.js
 *
 * This talks to MongoDB directly and removes exactly one record, matched by `_id`.
 * An id that does not exist is refused rather than passing silently.
 *
 * Nothing else is touched: the `model_providers`, `skills`, and `mcp_servers` records
 * this agent referenced stay where they are, along with their credentials, because
 * other agents may reference them too.
 *
 * Deleting the default record leaves no default, so `npm run agent:run` without
 * `--agent <name>` fails until another record takes the flag. The script says so
 * when that happens.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to delete, as the 24-character hex string MongoDB
 * shows. `seedAgent.js` prints the `_id` when it inserts a record.
 */
const AGENT_ID = '6a68eb69acab70f9ed8ce811';

/** Safety catch: set to true to let the delete run. */
const CONFIRM = false;

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const agents = client.db().collection('agents');

try {
  const existing = await agents.findOne({ _id: new ObjectId(AGENT_ID) });
  if (!existing) {
    throw new Error(`${AGENT_ID}: no record with this _id, nothing to delete`);
  }
  if (!CONFIRM) {
    throw new Error(
      `${existing.name}: refusing to delete while CONFIRM is false. This would remove the ` +
        `agent referencing model provider ${existing.modelProviderId} with ` +
        `${(existing.tools ?? []).length} tool(s), ${(existing.skills ?? []).length} skill(s), ` +
        `and ${(existing.mcpServerIds ?? []).length} MCP server(s) ` +
        `(default=${existing.isDefault === true}). Its system prompt is stored only here and ` +
        'is not recoverable; the skills it referenced are shared records and survive.',
    );
  }

  await agents.deleteOne({ _id: existing._id });
  console.log(`deleted ${existing.name} -> model provider ${existing.modelProviderId}`);

  if (existing.isDefault === true) {
    const remaining = await agents.countDocuments({ enabled: true });
    console.log(
      'that record was the default, so a run without --agent <name> now has no agent to ' +
        `select. ${remaining} enabled record(s) remain. Add it back with seedAgent.js, or ` +
        'set isDefault on another record with editAgent.js.',
    );
  }
} finally {
  await client.close();
}

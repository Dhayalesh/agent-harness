#!/usr/bin/env node
/**
 * Deletes one `skills` record. Edit the variables below, then run:
 *
 *   node scripts/skill/deleteSkill.js
 *
 * This talks to MongoDB directly and removes exactly one record, matched by `_id`.
 * An id that does not exist is refused rather than passing silently.
 *
 * The Markdown in S3 is not touched: this removes the platform's record of the skill,
 * not the skill itself. Agents referencing it stop resolving, so the script counts them
 * first and refuses while any remain.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to delete, as the 24-character hex string MongoDB shows.
 * `seedSkill.js` prints the `_id` when it inserts a record.
 */
const SKILL_ID = '6a68eb69acab70f9ed8ce811';

/** Safety catch: set to true to let the delete run. */
const CONFIRM = false;

/**
 * Deletes even while agents still reference this skill. Those agents fail at
 * resolution with SKILL_NOT_FOUND until the reference is removed from them.
 */
const ORPHAN_AGENTS = false;

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const database = client.db();
const skills = database.collection('skills');
const agents = database.collection('agents');

try {
  const existing = await skills.findOne({ _id: new ObjectId(SKILL_ID) });
  if (!existing) {
    throw new Error(`${SKILL_ID}: no record with this _id, nothing to delete`);
  }

  // MongoDB enforces no foreign keys, so the referencing side is counted here.
  const referencing = await agents.find({ 'skills.skillId': SKILL_ID }).toArray();
  if (referencing.length > 0 && !ORPHAN_AGENTS) {
    throw new Error(
      `${existing.name}: ${referencing.length} agent(s) still reference this skill ` +
        `(${referencing.map((agent) => agent.name).join(', ')}). They would stop resolving. ` +
        'Remove it from them with npx tsx scripts/agent/editAgent.ts, or set ORPHAN_AGENTS to true.',
    );
  }
  if (!CONFIRM) {
    throw new Error(
      `${existing.name}: refusing to delete while CONFIRM is false. This would remove the ` +
        `record pointing at ${existing.uri}. The Markdown in S3 is not touched, so the skill ` +
        'itself survives and the record can be re-added with seedSkill.js.',
    );
  }

  await skills.deleteOne({ _id: existing._id });
  console.log(`deleted ${existing.name} -> ${existing.uri}`);

  if (referencing.length > 0) {
    console.log(
      `${referencing.length} agent(s) now reference a skill that is gone and will fail at ` +
        `resolution: ${referencing.map((agent) => agent.name).join(', ')}. ` +
        'Fix with npx tsx scripts/agent/editAgent.ts.',
    );
  }
} finally {
  await client.close();
}

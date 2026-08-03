#!/usr/bin/env node
/**
 * Edits one existing `skills` record. Edit the variables below, then run:
 *
 *   node scripts/skill/editSkill.js
 *
 * This talks to MongoDB directly and finds the record by `_id`. It only updates: an
 * id that does not exist is refused, so a typo cannot silently create a second
 * record. Use `seedSkill.js` to add one and `deleteSkill.js` to remove one.
 *
 * There are three things to change, because a record holds three: its name, the address
 * of its document, and whether it is enabled. To change what the skill *says* — its
 * description, its `allowedTools`, or its instructions — edit the Markdown and re-upload
 * it to the same key. Nothing here needs re-running afterwards: the document is read
 * fresh on every run, and no digest is recorded that could go stale.
 *
 * A skill is shared, so a change here reaches every agent referencing it. That is the
 * point of the collection, and the reason the script prints how many.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to edit, as the 24-character hex string MongoDB shows.
 * `seedSkill.js` prints the `_id` when it inserts a record.
 */
const SKILL_ID = '6a68eb69acab70f9ed8ce811';

/** Only the fields to change. Delete or comment out the lines to leave alone. */
const CHANGES = {
  // name: 'abap-review-strict', // renames the record and its temp directory
  // uri: 's3://your-bucket/skills/abap-review.md', // repoints at another object
  // enabled: false, // agents referencing it then fail to resolve
};

// --- nothing below needs editing -------------------------------------------

/** Matches `skillName` in the schema, and the directory check in the runtime. */
const SKILL_NAME = /^[A-Za-z0-9_-]+$/;
/** S3 bucket naming: DNS-label safe, which the virtual-hosted URL form requires. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The characters an object key may hold here. Deliberately narrower than S3 allows. */
const KEY = /^[A-Za-z0-9!_.*'()/-]+$/;

/** The same parse `seedSkill.js` does; see the note there on why it is restated. */
function parseS3Uri(name, uri) {
  if (!uri.startsWith('s3://')) {
    throw new Error(`${name}: uri must be an s3://bucket/key address, received '${uri}'`);
  }
  const rest = uri.slice('s3://'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) {
    throw new Error(`${name}: uri '${uri}' names no object key after the bucket`);
  }
  const bucket = rest.slice(0, separator);
  const key = rest.slice(separator + 1);
  if (!BUCKET.test(bucket)) {
    throw new Error(`${name}: '${bucket}' is not a usable S3 bucket name`);
  }
  if (key === '' || key.length > 1024 || !KEY.test(key) || key.includes('..')) {
    throw new Error(`${name}: '${key}' is not a usable object key`);
  }
  return { bucket, key };
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const database = client.db();
const skills = database.collection('skills');
const agents = database.collection('agents');

try {
  const existing = await skills.findOne({ _id: new ObjectId(SKILL_ID) });
  if (!existing) {
    throw new Error(`${SKILL_ID}: no record with this _id. Use seedSkill.js to add it.`);
  }
  if (Object.keys(CHANGES).length === 0) {
    throw new Error('CHANGES is empty: set at least one field to edit');
  }

  const name = CHANGES.name ?? existing.name;
  if (!SKILL_NAME.test(name)) {
    throw new Error(
      `${name}: a skill name becomes a directory name, so it takes letters, digits, underscore, ` +
        `and hyphen only. Expected ${SKILL_NAME.source}.`,
    );
  }
  if (name !== existing.name && (await skills.findOne({ name }))) {
    throw new Error(`${name}: another record already has this name`);
  }

  const uri = CHANGES.uri ?? existing.uri;
  const { bucket, key } = parseS3Uri(name, uri);

  const now = new Date().toISOString();
  await skills.updateOne(
    { _id: existing._id },
    {
      $set: {
        name,
        uri,
        ...(CHANGES.enabled === undefined ? {} : { enabled: CHANGES.enabled }),
        updatedAt: now,
      },
    },
  );
  const enabled = CHANGES.enabled ?? existing.enabled;

  const referencing = await agents.countDocuments({ 'skills.skillId': SKILL_ID });
  console.log(
    `updated ${existing.name}${name === existing.name ? '' : ` -> ${name}`} ` +
      `(${Object.keys(CHANGES).join(', ')}) -> bucket ${bucket}, key ${key}, enabled=${enabled}`,
  );
  if (referencing > 0) {
    console.log(`${referencing} agent(s) reference this skill and pick the change up on next run.`);
  }
  if (enabled === false && referencing > 0) {
    console.log(
      'it is disabled, so those agents now fail to resolve with SKILL_DISABLED until it is ' +
        're-enabled or removed from them.',
    );
  }
} finally {
  await client.close();
}

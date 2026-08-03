#!/usr/bin/env node
/**
 * Adds new `skills` records. Edit the variables below, then run:
 *
 *   node scripts/skill/seedSkill.js
 *
 * This talks to MongoDB directly. It only inserts: a name that already exists is
 * refused, so a run can never overwrite a record by accident. Use `editSkill.js` to
 * change an existing one and `deleteSkill.js` to remove one.
 *
 * The document shape must match the strict schema in
 * `src/platform/skill-definitions.ts`, so do not add fields.
 *
 * There are two things to configure, a name and an address, because that is all a
 * record holds. What the skill *says* — its description, its `allowedTools`, and its
 * instructions — is the front matter and body of the `SKILL.md` in S3, read fresh on
 * every run:
 *
 *   ---
 *   description: Checklist for reviewing an ABAP change before it is transported
 *   allowedTools: read_file, grep
 *   ---
 *   Read the object before changing it, then check for hardcoded clients.
 *
 * Upload that file to S3 however you like — console, aws-cli, or
 * `npx tsx --env-file=.env scripts/content/uploadSkill.ts` — then register the address
 * here. The region and credential used to read it come from `.env`, not from this
 * record.
 *
 * Plain JS talking to the driver, so `node` runs it with no build step. That means it
 * cannot reach S3 to confirm the object is really there: signing a request needs the
 * TypeScript reader. A wrong address therefore surfaces on the first run that uses the
 * skill, as CONTENT_NOT_FOUND naming the skill and the key.
 */
import { MongoClient } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * One entry per skill to add. A skill is shared: any number of agents may reference
 * the same record, which is why it lives here rather than on one agent.
 *
 * `name` is the handle. It becomes a directory name under the run's temporary
 * directory and the string the model passes to the `skill` tool, so it takes letters,
 * digits, underscore, and hyphen only, and no two records may share one.
 *
 * `uri` is the whole S3 address of the `SKILL.md`. `s3://bucket/key` is the form worth
 * storing; the https address the console shows is also accepted.
 */
const SKILLS = [
  {
    name: 'SAP-Custom-Object-Documentation',
    uri: 's3://agent-core-docs/skills/Documentation.md',
  },
];

// --- nothing below needs editing -------------------------------------------

/** Matches `skillName` in the schema, and the directory check in the runtime. */
const SKILL_NAME = /^[A-Za-z0-9_-]+$/;
/** S3 bucket naming: DNS-label safe, which the virtual-hosted URL form requires. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The characters an object key may hold here. Deliberately narrower than S3 allows. */
const KEY = /^[A-Za-z0-9!_.*'()/-]+$/;

/**
 * The same parse `src/content/s3-uri.ts` does, restated because this script is plain JS
 * and cannot import it. Only the `s3://` form is accepted here: it is the one to store,
 * and an operator writing a record by hand has no reason to reach for the other.
 */
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
    throw new Error(
      `${name}: '${bucket}' is not a usable S3 bucket name. It must be 3 to 63 characters of ` +
        'lowercase letters, digits, dots, and hyphens, starting and ending with a letter or digit.',
    );
  }
  if (key === '' || key.length > 1024 || !KEY.test(key) || key.includes('..')) {
    throw new Error(`${name}: '${key}' is not a usable object key`);
  }
  return { bucket, key };
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const skills = client.db().collection('skills');

try {
  // `_id` needs no index here: MongoDB creates a unique one for it. `name` is unique
  // because it is the handle: two records claiming one name would collide in the
  // registry and in the temporary directory.
  await Promise.all([
    skills.createIndex({ name: 1 }, { unique: true }),
    skills.createIndex({ enabled: 1 }),
  ]);

  for (const entry of SKILLS) {
    if (!SKILL_NAME.test(entry.name)) {
      throw new Error(
        `${entry.name}: a skill name becomes a directory name, so it takes letters, digits, ` +
          `underscore, and hyphen only. Expected ${SKILL_NAME.source}.`,
      );
    }
    if (await skills.findOne({ name: entry.name })) {
      throw new Error(
        `${entry.name}: a record with this name already exists. Use editSkill.js to change it, ` +
          'or deleteSkill.js to remove it first.',
      );
    }
    const { bucket, key } = parseS3Uri(entry.name, entry.uri);

    const now = new Date().toISOString();
    // No id field: MongoDB assigns `_id` on insert and that is the record's id.
    const document = {
      name: entry.name,
      uri: entry.uri,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'operator',
    };
    const result = await skills.insertOne(document);

    console.log(
      `inserted ${document.name} -> bucket ${bucket}, key ${key} ` +
        `(_id=${result.insertedId.toHexString()})`,
    );
  }
} finally {
  await client.close();
}

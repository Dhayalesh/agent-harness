#!/usr/bin/env node
/**
 * Edits one existing `model_providers` record. Edit the variables below, then
 * run:
 *
 *   node model_scripts/editModel.js
 *
 * This talks to MongoDB directly and finds the record by `id`. It only updates: an
 * id that does not exist is refused, so a typo cannot silently create a second
 * record. Use `seedModel.js` to add one and `deleteModel.js` to remove one.
 *
 * The record keeps its `id` and `createdAt`. Only the fields set in `CHANGES` are
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
 * document. `seedModel.js` prints the `_id` when it inserts a record.
 */
const MODEL_ID = '6a68eb69acab70f9ed8ce811';

/**
 * Only the fields to change. Delete or comment out the lines to leave alone.
 * `maxOutputTokens` must stay smaller than `contextWindow` on the merged record,
 * and setting `isDefault: true` takes the default away from whichever record
 * holds it now.
 */
const CHANGES = {
  // name: 'bedrock-kimi-k2.5', // renames the record
  // provider: 'openai-compatible',
  // model: 'moonshotai.kimi-k2.5',
  // baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
  // apiKey: '', // rotates the credential
  // contextWindow: 256000,
  // maxOutputTokens: 64000,
  // enabled: true,
  // isDefault: true,
};

// --- nothing below needs editing -------------------------------------------

const CAPABILITY_FIELDS = ['contextWindow', 'maxOutputTokens'];
const RECORD_FIELDS = ['name', 'provider', 'model', 'baseURL', 'apiKey', 'enabled', 'isDefault'];

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const providers = client.db().collection('model_providers');

try {
  const existing = await providers.findOne({ _id: new ObjectId(MODEL_ID) });
  if (!existing) {
    throw new Error(`${MODEL_ID}: no record with this _id. Use seedModel.js to add it.`);
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
  if (CHANGES.provider !== undefined) {
    merged.capabilities.reportsCost = CHANGES.provider === 'openrouter';
  }
  if (CHANGES.apiKey !== undefined && !CHANGES.apiKey.trim()) {
    throw new Error(`${existing.name}: apiKey cannot be set to an empty value`);
  }
  if (merged.capabilities.maxOutputTokens >= merged.capabilities.contextWindow) {
    throw new Error(
      `${merged.name}: maxOutputTokens (${merged.capabilities.maxOutputTokens}) must be ` +
        `smaller than contextWindow (${merged.capabilities.contextWindow})`,
    );
  }
  if (merged.name !== existing.name && (await providers.findOne({ name: merged.name }))) {
    throw new Error(`${merged.name}: a record with this name already exists`);
  }

  // At most one default, matching what the runtime expects to find.
  if (merged.isDefault === true) {
    await providers.updateMany(
      { _id: { $ne: merged._id }, isDefault: true },
      { $set: { isDefault: false, updatedAt: now } },
    );
  }
  await providers.replaceOne({ _id: merged._id }, merged);

  console.log(
    `updated ${existing.name}${merged.name === existing.name ? '' : ` -> ${merged.name}`} ` +
      `(${Object.keys(CHANGES).join(', ')}) -> ${merged.provider} ${merged.model} ` +
      `(contextWindow=${merged.capabilities.contextWindow}, ` +
      `maxOutputTokens=${merged.capabilities.maxOutputTokens}, ` +
      `enabled=${merged.enabled}, default=${merged.isDefault === true}, ` +
      `apiKey=${CHANGES.apiKey === undefined ? 'unchanged' : 'rotated'}, not printed)`,
  );
} finally {
  await client.close();
}

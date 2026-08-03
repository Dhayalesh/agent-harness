#!/usr/bin/env node
/**
 * Deletes one `model_providers` record. Edit the variables below, then run:
 *
 *   node scripts/model/deleteModel.js
 *
 * This talks to MongoDB directly and removes exactly one record, matched by `_id`.
 * An id that does not exist is refused rather than passing silently.
 *
 * Deleting the default record leaves no default behind, so a run with an empty
 * `PLATFORM_MODEL_PROVIDER` will fail with MODEL_PROVIDER_NOT_FOUND until
 * another record is made the default. The script says so when that happens.
 */
import { MongoClient, ObjectId } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * The `_id` of the record to delete, as the 24-character hex string MongoDB
 * shows. `seedModel.js` prints the `_id` when it inserts a record.
 */
const MODEL_ID = '6a68eb69acab70f9ed8ce811';

/** Safety catch: set to true to let the delete run. */
const CONFIRM = false;

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const providers = client.db().collection('model_providers');

try {
  const existing = await providers.findOne({ _id: new ObjectId(MODEL_ID) });
  if (!existing) {
    throw new Error(`${MODEL_ID}: no record with this _id, nothing to delete`);
  }
  if (!CONFIRM) {
    throw new Error(
      `${existing.name}: refusing to delete while CONFIRM is false. This would remove ` +
        `${existing.provider} ${existing.model} (default=${existing.isDefault === true}) ` +
        'and its stored credential.',
    );
  }

  await providers.deleteOne({ _id: existing._id });
  console.log(`deleted ${existing.name} -> ${existing.provider} ${existing.model}`);

  if (existing.isDefault === true) {
    const remaining = await providers.countDocuments({});
    console.log(
      'that was the default record, so no default remains. ' +
        `Set isDefault on one of the ${remaining} remaining record(s) with editModel.js, ` +
        'or select one by name with PLATFORM_MODEL_PROVIDER.',
    );
  }
} finally {
  await client.close();
}

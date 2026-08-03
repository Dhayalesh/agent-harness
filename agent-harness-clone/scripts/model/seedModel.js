#!/usr/bin/env node
/**
 * Adds new `model_providers` records. Edit the variables below, then run:
 *
 *   node scripts/model/seedModel.js
 *
 * This talks to MongoDB directly. It only inserts: a name that already exists is
 * refused, so a run can never overwrite a record by accident. Use
 * `editModel.js` to change an existing one and `deleteModel.js` to remove one.
 *
 * The document shape must match the strict schema in
 * `src/platform/model-provider-definitions.ts`, so do not add fields.
 * The credential is stored on the record. Do not commit a real `apiKey` value.
 */
import { MongoClient } from 'mongodb';

// --- edit these ------------------------------------------------------------

/** Connection string. The path segment is the database name. */
const MONGODB_URI = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

/**
 * One entry per model to add. At most one entry should set `isDefault: true`:
 * that is the record a run picks when `PLATFORM_MODEL_PROVIDER` is empty, and it
 * takes the default away from whichever record holds it now.
 *
 * `contextWindow` and `maxOutputTokens` are both honoured at run time: the CLI
 * spends them as the session's input budget and output ceiling, so
 * `maxOutputTokens` must be smaller than `contextWindow`.
 */
const MODELS = [
  {
    name: 'NVIDIA Model',
    provider: 'openai-compatible', // 'openai-compatible' or 'openrouter'
    model: 'nvidia.nemotron-super-3-120b',
    baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1', // omit for openrouter
    apiKey:
      'ABSKTWFudGxlQXBpS2V5LTVoOTl5MDZjLWF0LTQ5ODM0MTk3NTA0ODpWbkVsMDgyZGlYcFVETDdtUEIwSEVhaXRnVXdmaTZwVVRLQ3E5Y29mbHZhbXYrTFBLUk01TGRXdW50cz0=',
    contextWindow: 256000,
    maxOutputTokens: 32000,
    isDefault: true,
  },
];

// --- nothing below needs editing -------------------------------------------

const client = new MongoClient(MONGODB_URI);
await client.connect();
// No database name argument: the one in MONGODB_URI is used.
const providers = client.db().collection('model_providers');

try {
  // `_id` needs no index here: MongoDB creates a unique one for it.
  await Promise.all([
    providers.createIndex({ name: 1 }, { unique: true }),
    providers.createIndex({ enabled: 1 }),
  ]);

  for (const entry of MODELS) {
    if (await providers.findOne({ name: entry.name })) {
      throw new Error(
        `${entry.name}: a record with this name already exists. Use editModel.js to ` +
          'change it, or deleteModel.js to remove it first.',
      );
    }
    if (entry.maxOutputTokens >= entry.contextWindow) {
      throw new Error(
        `${entry.name}: maxOutputTokens (${entry.maxOutputTokens}) must be smaller than ` +
          `contextWindow (${entry.contextWindow})`,
      );
    }
    if (!(entry.apiKey ?? '').trim()) {
      throw new Error(`${entry.name}: apiKey is required to add a record`);
    }

    const now = new Date().toISOString();
    // No id field: MongoDB assigns `_id` on insert and that is the record's id.
    const document = {
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
      apiKey: entry.apiKey.trim(),
      auth: { kind: 'bearer' },
      capabilities: {
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        supportsTools: true,
        supportsStreaming: true,
        supportsReasoning: false,
        reportsCost: entry.provider === 'openrouter',
      },
      enabled: true,
      isDefault: entry.isDefault === true,
      createdAt: now,
      updatedAt: now,
      createdBy: 'operator',
    };

    // At most one default, matching what the runtime expects to find.
    if (document.isDefault) {
      await providers.updateMany(
        { isDefault: true },
        { $set: { isDefault: false, updatedAt: now } },
      );
    }
    const result = await providers.insertOne(document);

    console.log(
      `inserted ${document.name} -> ${document.provider} ${document.model} ` +
        `(contextWindow=${entry.contextWindow}, maxOutputTokens=${entry.maxOutputTokens}, ` +
        `default=${document.isDefault}, _id=${result.insertedId.toHexString()}, ` +
        'apiKey stored, not printed)',
    );
  }
} finally {
  await client.close();
}

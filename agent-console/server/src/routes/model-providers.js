import express from "express";
import { config } from "../config.js";
import { asyncHandler, conflict } from "../lib/http-error.js";
import {
  modelProviderCreateSchema,
  modelProviderRecordSchema,
  modelProviderUpdateSchema,
  parseOrThrow,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { ModelProvider } from "../models/model-provider.js";
import {
  createRecord,
  loadModelProvider,
  nowIso,
  safeModelProvider,
  saveMergedRecord,
} from "../services/platform.js";

export const modelProvidersRouter = express.Router();

modelProvidersRouter.get("/", asyncHandler(async (request, response) => {
  const filter = searchFilter(request.query.q);
  if (request.query.enabled === "true") filter.enabled = true;
  if (request.query.enabled === "false") filter.enabled = false;
  const modelProviders = await ModelProvider.find(filter)
    .select("+apiKey +headers")
    .sort({ name: 1 })
    .limit(200);
  response.json({
    modelProviders: modelProviders.map(safeModelProvider),
    total: await ModelProvider.countDocuments(filter),
  });
}));

modelProvidersRouter.get("/:id", asyncHandler(async (request, response) => {
  const modelProvider = await loadModelProvider(request.params.id, {
    withSecrets: true,
  });
  response.json({
    modelProvider: safeModelProvider(modelProvider),
    referencedByCount: await Agent.countDocuments({
      modelProviderId: modelProvider._id.toString(),
    }),
  });
}));

modelProvidersRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(modelProviderCreateSchema, request.body);
  let modelProvider;
  try {
    modelProvider = await createRecord(ModelProvider, {
      ...input,
      createdBy: config.createdBy,
    });
    if (input.isDefault) await clearOtherDefaults(modelProvider._id);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('A model provider named "' + input.name + '" already exists');
    }
    throw error;
  }
  response.status(201).json({ modelProvider: safeModelProvider(modelProvider) });
}));

modelProvidersRouter.patch("/:id", asyncHandler(async (request, response) => {
  const patch = parseOrThrow(modelProviderUpdateSchema, request.body);
  const modelProvider = await loadModelProvider(request.params.id, {
    withSecrets: true,
  });
  try {
    await saveMergedRecord(
      modelProvider,
      patch,
      modelProviderRecordSchema,
      "Model provider",
      { secretStrings: ["apiKey"], secretMaps: ["headers"] },
    );
    if (patch.isDefault === true) await clearOtherDefaults(modelProvider._id);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('A model provider named "' + modelProvider.name + '" already exists');
    }
    throw error;
  }
  response.json({ modelProvider: safeModelProvider(modelProvider) });
}));

modelProvidersRouter.delete("/:id", asyncHandler(async (request, response) => {
  const modelProvider = await loadModelProvider(request.params.id);
  const referencedByCount = await Agent.countDocuments({
    modelProviderId: modelProvider._id.toString(),
  });
  if (referencedByCount) {
    throw conflict(
      "Cannot delete a model provider referenced by " +
        referencedByCount +
        " agent(s).",
    );
  }
  await modelProvider.deleteOne();
  response.json({ deleted: true, id: request.params.id });
}));

async function clearOtherDefaults(id) {
  await ModelProvider.updateMany(
    { _id: { $ne: id }, isDefault: true },
    { $set: { isDefault: false, updatedAt: nowIso() } },
  );
}

function searchFilter(query) {
  if (!query) return {};
  const safe = escapeSearch(query);
  return { name: { $regex: safe, $options: "i" } };
}

function escapeSearch(value) {
  return [...String(value).slice(0, 100)]
    .map((character) =>
      ".*+?^$()|[]{}".includes(character) || character.charCodeAt(0) === 92
        ? String.fromCharCode(92) + character
        : character,
    )
    .join("");
}

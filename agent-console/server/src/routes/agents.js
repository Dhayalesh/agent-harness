import { randomUUID } from "node:crypto";
import express from "express";
import { AVAILABLE_TOOLS, READ_ONLY_TOOLS, CONFIGURABLE_MODEL_PROVIDERS, config } from "../config.js";
import { asyncHandler, conflict } from "../lib/http-error.js";
import {
  agentCreateSchema,
  agentRecordSchema,
  agentUpdateSchema,
  invokeSchema,
  parseOrThrow,
  parseRecordOrThrow,
} from "../lib/schemas.js";
import { Agent } from "../models/agent.js";
import { Chat } from "../models/chat.js";
import { Run } from "../models/run.js";
import { resolveRuntime } from "../services/agentcore.js";
import { invokeStoredAgent } from "../services/invocation.js";
import { buildPayload, redactPayload } from "../services/payload.js";
import {
  assertAgentReferences,
  createRecord,
  loadAgent,
  nowIso,
  plain,
  resolveAgentSummaries,
} from "../services/platform.js";

export const agentsRouter = express.Router();

agentsRouter.get("/meta/tools", (_request, response) => {
  response.json({
    tools: AVAILABLE_TOOLS.map((name) => ({
      name,
      readOnly: READ_ONLY_TOOLS.includes(name),
    })),
    providers: CONFIGURABLE_MODEL_PROVIDERS,
  });
});

agentsRouter.get("/", asyncHandler(async (request, response) => {
  const filter = {};
  if (request.query.enabled === "true") filter.enabled = true;
  if (request.query.enabled === "false") filter.enabled = false;
  if (request.query.q) {
    const safe = escapeSearch(request.query.q);
    filter.$or = [
      { name: { $regex: safe, $options: "i" } },
      { description: { $regex: safe, $options: "i" } },
    ];
  }
  const agents = await Agent.find(filter).sort({ updatedAt: -1 }).limit(200);
  response.json({
    agents: await resolveAgentSummaries(agents),
    total: await Agent.countDocuments(filter),
  });
}));

agentsRouter.get("/:id", asyncHandler(async (request, response) => {
  const agent = await loadAgent(request.params.id);
  const [resolved] = await resolveAgentSummaries([agent], {
    includeSystemPrompt: true,
  });
  const id = agent._id.toString();
  const [runCount, chatCount] = await Promise.all([
    Run.countDocuments({ agentId: id }),
    Chat.countDocuments({ agentId: id }),
  ]);
  response.json({ agent: resolved, runCount, chatCount });
}));

agentsRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(agentCreateSchema, request.body);
  await assertAgentReferences(input);
  let agent;
  try {
    agent = await createRecord(Agent, {
      ...input,
      createdBy: config.createdBy,
    });
    if (input.isDefault) await clearOtherDefaults(agent._id);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('An agent named "' + input.name + '" already exists');
    }
    throw error;
  }
  const [resolved] = await resolveAgentSummaries([agent], {
    includeSystemPrompt: true,
  });
  response.status(201).json({ agent: resolved });
}));

agentsRouter.patch("/:id", asyncHandler(async (request, response) => {
  const patch = parseOrThrow(agentUpdateSchema, request.body);
  const agent = await loadAgent(request.params.id);
  const candidate = { ...plain(agent), ...patch, updatedAt: nowIso() };
  for (const field of ["description", "model", "isDefault"]) {
    if (candidate[field] === null) delete candidate[field];
  }
  const validated = parseRecordOrThrow(agentRecordSchema, candidate, "Agent");
  await assertAgentReferences(validated);
  agent.set(validated);
  // `set(object)` only writes keys present in the object. The validation
  // candidate deliberately omits explicit nulls, so unset those fields on the
  // document as well instead of accidentally retaining their previous values.
  for (const field of ["description", "model", "isDefault"]) {
    if (patch[field] === null) agent.set(field, undefined);
  }
  try {
    await agent.save();
    if (patch.isDefault === true) await clearOtherDefaults(agent._id);
  } catch (error) {
    if (error?.code === 11000) {
      throw conflict('An agent named "' + agent.name + '" already exists');
    }
    throw error;
  }
  const [resolved] = await resolveAgentSummaries([agent], {
    includeSystemPrompt: true,
  });
  response.json({ agent: resolved });
}));

agentsRouter.delete("/:id", asyncHandler(async (request, response) => {
  const agent = await loadAgent(request.params.id);
  const id = agent._id.toString();
  const withHistory = request.query.withHistory === "true";
  let deletedRuns = 0;
  let deletedChats = 0;
  if (request.query.withRuns === "true" || withHistory) {
    deletedRuns = (await Run.deleteMany({ agentId: id })).deletedCount ?? 0;
  }
  if (withHistory) {
    deletedChats = (await Chat.deleteMany({ agentId: id })).deletedCount ?? 0;
  }
  await agent.deleteOne();
  response.json({
    deleted: true,
    id,
    deletedRuns,
    deletedChats,
  });
}));

agentsRouter.post("/:id/preview", asyncHandler(async (request, response) => {
  const input = parseOrThrow(invokeSchema, request.body);
  const runtimeSessionId = input.runtimeSessionId ?? randomUUID();
  const { payload, resolved } = await buildPayload({
    agentId: request.params.id,
    prompt: input.prompt,
    sessionId: runtimeSessionId,
    permissionMode: input.permissionMode,
    includeEvents: input.includeEvents,
  });
  const runtime = resolveRuntime(resolved.agent.value);
  response.json({
    target: {
      agentRuntimeArn: runtime.arn,
      qualifier: runtime.qualifier ?? "DEFAULT",
      region: runtime.region,
      accountId: runtime.accountId,
      runtimeSessionId,
      source: "AGENTCORE_RUNTIME_ARN",
      credentialReady: Boolean(resolved.modelProvider.value.apiKey),
    },
    payload: redactPayload(payload),
    skillRouting: resolved.skillRouting,
  });
}));

agentsRouter.post("/:id/invoke", asyncHandler(async (request, response) => {
  const input = parseOrThrow(invokeSchema, request.body);
  const result = await invokeStoredAgent({
    agentId: request.params.id,
    prompt: input.prompt,
    runtimeSessionId: input.runtimeSessionId,
    permissionMode: input.permissionMode,
    includeEvents: input.includeEvents,
  });
  response.status(201).json({ run: result.run, events: result.events });
}));

async function clearOtherDefaults(id) {
  await Agent.updateMany(
    { _id: { $ne: id }, isDefault: true },
    { $set: { isDefault: false, updatedAt: nowIso() } },
  );
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

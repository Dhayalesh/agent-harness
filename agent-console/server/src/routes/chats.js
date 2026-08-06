import { randomUUID } from "node:crypto";
import express from "express";
import { asyncHandler, notFound } from "../lib/http-error.js";
import {
  chatCreateSchema,
  chatMessageSchema,
  chatUpdateSchema,
  parseOrThrow,
} from "../lib/schemas.js";
import { Chat, chatSummaries } from "../models/chat.js";
import { Run } from "../models/run.js";
import { invokeStoredAgent } from "../services/invocation.js";
import {
  loadAgent,
  nowIso,
  requireObjectId,
} from "../services/platform.js";

export const chatsRouter = express.Router();

chatsRouter.get("/", asyncHandler(async (request, response) => {
  const filter = {};
  if (request.query.agentId) filter.agentId = String(request.query.agentId);
  const limit = Math.min(
    Math.max(Number.parseInt(request.query.limit ?? "50", 10) || 50, 1),
    200,
  );
  const chats = await chatSummaries(filter, limit);
  response.json({
    chats,
    total: await Chat.countDocuments(filter),
  });
}));

chatsRouter.post("/", asyncHandler(async (request, response) => {
  const input = parseOrThrow(chatCreateSchema, request.body);
  const agent = await loadAgent(input.agentId, { requireEnabled: true });
  const timestamp = nowIso();
  const chat = await Chat.create({
    title: input.title ?? agent.name + " chat",
    agentId: agent._id.toString(),
    agentName: agent.name,
    runtimeSessionId: randomUUID(),
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  response.status(201).json({ chat: chatDetail(chat) });
}));

chatsRouter.get("/:id", asyncHandler(async (request, response) => {
  response.json({ chat: chatDetail(await loadChat(request.params.id)) });
}));

chatsRouter.patch("/:id", asyncHandler(async (request, response) => {
  const input = parseOrThrow(chatUpdateSchema, request.body);
  const chat = await loadChat(request.params.id);
  chat.title = input.title;
  chat.updatedAt = nowIso();
  await chat.save();
  response.json({ chat: chatDetail(chat) });
}));

chatsRouter.delete("/:id", asyncHandler(async (request, response) => {
  const chat = await loadChat(request.params.id);
  let deletedRuns = 0;
  if (request.query.withRuns === "true") {
    deletedRuns = (await Run.deleteMany({ chatId: chat._id.toString() })).deletedCount ?? 0;
  }
  await chat.deleteOne();
  response.json({ deleted: true, id: request.params.id, deletedRuns });
}));

chatsRouter.post("/:id/messages", asyncHandler(async (request, response) => {
  const input = parseOrThrow(chatMessageSchema, request.body);
  const chat = await loadChat(request.params.id);
  const agent = await loadAgent(chat.agentId, { requireEnabled: true });
  const replayPrompt = buildReplayPrompt(chat.messages, input.content);
  const userTimestamp = nowIso();
  chat.agentName = agent.name;
  chat.messages.push({
    id: randomUUID(),
    role: "user",
    content: input.content,
    createdAt: userTimestamp,
  });
  chat.lastMessageAt = userTimestamp;
  chat.updatedAt = userTimestamp;
  await chat.save();

  let invocation;
  try {
    invocation = await invokeStoredAgent({
      agentId: chat.agentId,
      prompt: replayPrompt,
      runtimeSessionId: chat.runtimeSessionId,
      permissionMode: input.permissionMode,
      includeEvents: input.includeEvents,
      chatId: chat._id.toString(),
    });
  } catch (error) {
    const timestamp = nowIso();
    chat.messages.push({
      id: randomUUID(),
      role: "error",
      content: error.message,
      createdAt: timestamp,
      error: {
        code: "INVOCATION_FAILED",
        message: error.message,
        recoverable: error.status === 409 || error.status === 429,
      },
    });
    chat.lastMessageAt = timestamp;
    chat.updatedAt = timestamp;
    await chat.save();
    throw error;
  }

  const timestamp = nowIso();
  chat.messages.push({
    id: randomUUID(),
    role: invocation.result.status === "success" ? "assistant" : "error",
    content:
      invocation.result.output ||
      invocation.result.error?.message ||
      "The agent returned no output.",
    runId: invocation.run._id.toString(),
    createdAt: timestamp,
    ...(invocation.result.error ? { error: invocation.result.error } : {}),
  });
  chat.lastMessageAt = timestamp;
  chat.updatedAt = timestamp;
  await chat.save();
  response.status(201).json({
    chat: chatDetail(chat),
    run: invocation.run,
    events: invocation.events,
  });
}));

async function loadChat(id) {
  const chat = await Chat.findById(requireObjectId(id, "chat"));
  if (!chat) throw notFound("No chat with id " + id);
  return chat;
}

function chatDetail(chat) {
  return chat.toJSON();
}

export function buildReplayPrompt(messages, latest, maximum = 2_000_000) {
  const previous = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (!previous.length) return latest;

  const header =
    "Continue the conversation below. Preserve its context and answer the final user message.\n\n";
  const finalBlock = "User:\n" + latest;
  if (header.length + finalBlock.length >= maximum) {
    return latest.slice(0, maximum);
  }
  const blocks = previous.map(
    (message) =>
      (message.role === "user" ? "User:\n" : "Assistant:\n") +
      message.content,
  );
  let selected = [];
  let size = header.length + finalBlock.length;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const addition = block.length + 2;
    if (size + addition > maximum) break;
    selected.unshift(block);
    size += addition;
  }
  if (!selected.length) return latest.slice(0, maximum);
  return header + selected.join("\n\n") + "\n\n" + finalBlock;
}

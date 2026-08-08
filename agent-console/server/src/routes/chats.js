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
import { invokeStoredAgent, streamStoredAgent } from "../services/invocation.js";
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

  const invocationInput = {
    agentId: chat.agentId,
    prompt: replayPrompt,
    runtimeSessionId: chat.runtimeSessionId,
    permissionMode: input.permissionMode,
    includeEvents: input.includeEvents,
    chatId: chat._id.toString(),
  };

  // Same rule the runtime applies one hop further on: the caller's Accept decides,
  // and the stored preference only answers for a caller that stated nothing. A
  // client that cannot read frames must never be sent them.
  if (!wantsEventStream(request, agent)) {
    let invocation;
    try {
      invocation = await invokeStoredAgent(invocationInput);
    } catch (error) {
      await appendFailure(chat, error);
      throw error;
    }
    await appendResult(chat, invocation);
    response.status(201).json({
      chat: chatDetail(chat),
      run: invocation.run,
      events: invocation.events,
    });
    return;
  }

  // Past this point the status line is already sent, so a failure travels as a
  // frame rather than as an HTTP error.
  openEventStream(response);
  const abort = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) abort.abort();
  });

  try {
    const invocation = await streamStoredAgent({
      ...invocationInput,
      signal: abort.signal,
      onEvent: (event) => writeEvent(response, event.type, event),
    });
    await appendResult(chat, invocation);
    await writeEvent(response, CONSOLE_COMPLETED, {
      type: CONSOLE_COMPLETED,
      chat: chatDetail(chat),
      run: invocation.run,
    });
  } catch (error) {
    await appendFailure(chat, error);
    await writeEvent(response, CONSOLE_FAILED, {
      type: CONSOLE_FAILED,
      chat: chatDetail(chat),
      error: error.message,
    });
  }
  response.end();
}));

/**
 * The two events the console adds to the harness protocol.
 *
 * Namespaced so a consumer can tell them apart from anything the runtime emits:
 * these carry the saved chat and run, which only this layer knows about.
 */
const CONSOLE_COMPLETED = "console.completed";
const CONSOLE_FAILED = "console.failed";

function wantsEventStream(request, agent) {
  const accept = String(request.headers.accept ?? "");
  if (request.query.stream === "true" || accept.includes("text/event-stream")) {
    return true;
  }
  if (request.query.stream === "false" || accept.includes("application/json")) {
    return false;
  }
  return agent.stream === true;
}

function openEventStream(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Proxies that buffer by default would hold every frame until the run ends.
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
}

/** Resolves once the socket has taken the frame, so a slow reader slows the run. */
function writeEvent(response, name, data) {
  if (response.writableEnded) return Promise.resolve();
  const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  if (response.write(frame)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

async function appendResult(chat, invocation) {
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
}

async function appendFailure(chat, error) {
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
}

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

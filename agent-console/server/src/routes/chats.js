import { randomUUID } from "node:crypto";
import express from "express";
import { asyncHandler, conflict, notFound } from "../lib/http-error.js";
import { config } from "../config.js";
import {
  chatCreateSchema,
  chatMessageSchema,
  chatUpdateSchema,
  parseOrThrow,
} from "../lib/schemas.js";
import { Chat, chatSummaries } from "../models/chat.js";
import { Run } from "../models/run.js";
import {
  invokeStoredAgent,
  streamStoredAgent,
} from "../services/invocation.js";
import { loadAgent, nowIso, requireObjectId } from "../services/platform.js";
import { loadArtifactBody } from "../services/artifact-content.js";
import {
  ARTIFACT_FORMATS,
  artifactKind,
} from "../services/artifact-formats.js";

export const chatsRouter = express.Router();

chatsRouter.get(
  "/",
  asyncHandler(async (request, response) => {
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
  }),
);

chatsRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const input = parseOrThrow(chatCreateSchema, request.body);
    const agent = await loadAgent(input.agentId, { requireEnabled: true });
    const timestamp = nowIso();
    const chat = await Chat.create({
      title: input.title ?? agent.name + " chat",
      agentId: agent._id.toString(),
      agentName: agent.name,
      runtimeSessionId: randomUUID(),
      session: {
        status: "new",
        generation: 1,
        historyStartIndex: 0,
        origin: "new",
        resumed: false,
        historyMessageCount: 0,
      },
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    response.status(201).json({ chat: chatDetail(chat) });
  }),
);

chatsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    response.json({ chat: chatDetail(await loadChat(request.params.id)) });
  }),
);

chatsRouter.get(
  "/:id/artifacts/:artifactId",
  asyncHandler(async (request, response) => {
    const chat = await loadChat(request.params.id);
    const artifact = chat.messages
      .flatMap((message) => message.artifacts ?? [])
      .find((candidate) => candidate.id === request.params.artifactId);
    if (!artifact)
      throw notFound("No artifact with id " + request.params.artifactId);
    const kind = artifactKind(artifact);
    if (!kind) throw notFound("Unsupported artifact format");
    const disposition =
      request.query.download === "true" ||
      ["html", "docx", "xlsx"].includes(kind)
        ? "attachment"
        : "inline";
    response.set({
      "content-type": ARTIFACT_FORMATS[kind].contentType,
      "content-disposition": `${disposition}; filename="${headerFilename(artifact.filename)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(kind === "html"
        ? { "content-security-policy": "sandbox; default-src 'none'" }
        : {}),
    });
    response.send(await loadArtifactBody(artifact));
  }),
);

chatsRouter.patch(
  "/:id",
  asyncHandler(async (request, response) => {
    const input = parseOrThrow(chatUpdateSchema, request.body);
    const chat = await loadChat(request.params.id);
    chat.title = input.title;
    chat.updatedAt = nowIso();
    await chat.save();
    response.json({ chat: chatDetail(chat) });
  }),
);

chatsRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const chat = await loadChat(request.params.id);
    let deletedRuns = 0;
    if (request.query.withRuns === "true") {
      deletedRuns =
        (await Run.deleteMany({ chatId: chat._id.toString() })).deletedCount ??
        0;
    }
    await chat.deleteOne();
    response.json({ deleted: true, id: request.params.id, deletedRuns });
  }),
);

chatsRouter.post(
  "/:id/session/reset",
  asyncHandler(async (request, response) => {
    const id = requireObjectId(request.params.id, "chat");
    await loadChat(request.params.id);
    const timestamp = nowIso();
    const chat = await Chat.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { "session.activeRequestId": { $exists: false } },
          { "session.activeRequestId": null },
          { "session.activeExpiresAt": { $lte: timestamp } },
        ],
      },
      [
        {
          $set: {
            runtimeSessionId: randomUUID(),
            session: {
              $mergeObjects: [
                "$session",
                {
                  status: "new",
                  generation: {
                    $add: [{ $ifNull: ["$session.generation", 0] }, 1],
                  },
                  historyStartIndex: {
                    $size: { $ifNull: ["$messages", []] },
                  },
                  origin: "new",
                  resumed: false,
                  historyMessageCount: 0,
                  lastActiveAt: timestamp,
                  activeRequestId: null,
                  activeExpiresAt: null,
                },
              ],
            },
            updatedAt: timestamp,
          },
        },
      ],
      { new: true },
    );
    if (!chat)
      throw conflict(
        "This session is currently running. Wait for it to finish before resetting.",
      );
    response.json({ chat: chatDetail(chat) });
  }),
);

chatsRouter.post(
  "/:id/messages",
  asyncHandler(async (request, response) => {
    const input = parseOrThrow(chatMessageSchema, request.body);
    const existing = await loadChat(request.params.id);
    const agent = await loadAgent(existing.agentId, { requireEnabled: true });
    const userTimestamp = nowIso();
    const requestId = randomUUID();
    const userMessage = {
      id: randomUUID(),
      role: "user",
      content: input.content,
      createdAt: userTimestamp,
    };
    const chat = await Chat.findOneAndUpdate(
      {
        _id: existing._id,
        $or: [
          { "session.activeRequestId": { $exists: false } },
          { "session.activeRequestId": null },
          { "session.activeExpiresAt": { $lte: userTimestamp } },
        ],
      },
      {
        $set: {
          agentName: agent.name,
          lastMessageAt: userTimestamp,
          updatedAt: userTimestamp,
          "session.status": "running",
          "session.activeRequestId": requestId,
          "session.activeExpiresAt": new Date(
            Date.now() + config.agentcore.timeoutMs + 60_000,
          ).toISOString(),
        },
        $push: { messages: userMessage },
      },
      { new: true },
    );
    if (!chat) {
      throw conflict(
        "This chat already has a message in progress. Wait for it to finish and retry.",
      );
    }
    const previousMessages = chat.messages.slice(0, -1);
    const sessionHistory = buildSessionHistory(
      previousMessages,
      chat.session?.historyStartIndex ?? 0,
    );

    const invocationInput = {
      agentId: chat.agentId,
      prompt: input.content,
      runtimeSessionId: chat.runtimeSessionId,
      permissionMode: input.permissionMode,
      includeEvents: input.includeEvents,
      chatId: chat._id.toString(),
      sessionHistory,
    };

    // Same rule the runtime applies one hop further on: the caller's Accept decides,
    // and the stored preference only answers for a caller that stated nothing. A
    // client that cannot read frames must never be sent them.
    if (!wantsEventStream(request, agent)) {
      let invocation;
      try {
        invocation = await invokeStoredAgent(invocationInput);
      } catch (error) {
        await appendFailure(chat, error, requestId);
        throw error;
      }
      const completedChat = await appendResult(chat, invocation, requestId);
      response.status(201).json({
        chat: chatDetail(completedChat),
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
      const completedChat = await appendResult(chat, invocation, requestId);
      await writeEvent(response, CONSOLE_COMPLETED, {
        type: CONSOLE_COMPLETED,
        chat: chatDetail(completedChat),
        run: invocation.run,
      });
    } catch (error) {
      const failedChat = await appendFailure(chat, error, requestId);
      await writeEvent(response, CONSOLE_FAILED, {
        type: CONSOLE_FAILED,
        chat: chatDetail(failedChat),
        error: error.message,
      });
    }
    response.end();
  }),
);

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

async function appendResult(chat, invocation, requestId) {
  const timestamp = nowIso();
  const message = {
    id: randomUUID(),
    role: invocation.result.status === "success" ? "assistant" : "error",
    content:
      invocation.result.output ||
      invocation.result.error?.message ||
      (invocation.result.artifacts?.length
        ? ""
        : "The agent returned no output."),
    ...(invocation.result.artifacts?.length
      ? { artifacts: invocation.result.artifacts }
      : {}),
    ...(invocation.result.toolCalls?.length
      ? { toolCalls: invocation.result.toolCalls }
      : {}),
    ...(invocation.result.reasoning
      ? { reasoning: invocation.result.reasoning }
      : {}),
    runId: invocation.run._id.toString(),
    createdAt: timestamp,
    ...(invocation.result.error ? { error: invocation.result.error } : {}),
  };
  const session = invocation.result.session;
  const updated = await Chat.findOneAndUpdate(
    { _id: chat._id, "session.activeRequestId": requestId },
    {
      $push: { messages: message },
      $set: {
        lastMessageAt: timestamp,
        updatedAt: timestamp,
        "session.status":
          invocation.result.status === "success" ? "active" : "error",
        "session.origin": session?.origin ?? "new",
        "session.storage": session?.storage ?? "custom",
        "session.resumed": session?.resumed === true,
        "session.historyMessageCount":
          session?.historyMessageCount ?? chat.messages.length + 1,
        "session.lastActiveAt": timestamp,
        "session.activeRequestId": null,
        "session.activeExpiresAt": null,
      },
    },
    { new: true },
  );
  if (!updated)
    throw conflict(
      "The chat session lease expired before the result was saved.",
    );
  return updated;
}

async function appendFailure(chat, error, requestId) {
  const timestamp = nowIso();
  const message = {
    id: randomUUID(),
    role: "error",
    content: error.message,
    createdAt: timestamp,
    error: {
      code: "INVOCATION_FAILED",
      message: error.message,
      recoverable: error.status === 409 || error.status === 429,
    },
  };
  const updated = await Chat.findOneAndUpdate(
    { _id: chat._id, "session.activeRequestId": requestId },
    {
      $push: { messages: message },
      $set: {
        lastMessageAt: timestamp,
        updatedAt: timestamp,
        "session.status": "error",
        "session.lastActiveAt": timestamp,
        "session.activeRequestId": null,
        "session.activeExpiresAt": null,
      },
    },
    { new: true },
  );
  if (!updated)
    throw conflict(
      "The chat session lease expired before the failure was saved.",
    );
  return updated;
}

async function loadChat(id) {
  const chat = await Chat.findById(requireObjectId(id, "chat"));
  if (!chat) throw notFound("No chat with id " + id);
  return chat;
}

function chatDetail(chat) {
  return chat.toJSON();
}

export function buildSessionHistory(
  messages,
  startIndex = 0,
  maximum = 1_500_000,
  maximumMessages = 200,
) {
  const previous = messages
    .slice(startIndex)
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.length > 0,
    );
  const selected = [];
  let size = 0;
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index];
    if (selected.length >= maximumMessages) break;
    if (size + message.content.length > maximum) break;
    selected.unshift({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    });
    size += message.content.length;
  }
  return selected;
}

function headerFilename(value) {
  const safe = String(value ?? "document")
    .replace(/[\x00-\x1F\x7F"\\]/g, "_")
    .trim();
  return safe || "document";
}

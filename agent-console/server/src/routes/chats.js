import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
} from "../lib/http-error.js";
import { config } from "../config.js";
import {
  chatCreateSchema,
  chatMessageSchema,
  chatUpdateSchema,
  parseOrThrow,
} from "../lib/schemas.js";
import { Attachment } from "../models/attachment.js";
import { Chat, chatSummaries } from "../models/chat.js";
import { Run } from "../models/run.js";
import {
  describeAttachment,
  safeUploadFilename,
} from "../services/attachment-types.js";
import { extractAttachment } from "../services/attachment-extract.js";
import {
  loadAttachmentBytes,
  storeAttachmentBytes,
} from "../services/attachment-storage.js";
import {
  invokeStoredAgent,
  streamStoredAgent,
} from "../services/invocation.js";
import {
  loadAgent,
  loadModelProvider,
  nowIso,
  requireObjectId,
} from "../services/platform.js";
import { generateChatTitle, hasDefaultTitle } from "../services/chat-title.js";
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

/**
 * Buffered in memory rather than spooled to disk.
 *
 * Every accepted upload is read end to end anyway — text is extracted from it
 * immediately — so a temporary file would be written and deleted for no gain, and
 * disk storage is the multer path with the orphaned-file failure mode.
 */
const uploads = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxFileBytes,
    files: config.uploads.maxFiles,
    // Nothing but files is expected on this endpoint; a bounded field count keeps
    // the multipart parser from being handed arbitrary form data.
    fields: 2,
    parts: config.uploads.maxFiles + 2,
  },
});

chatsRouter.post(
  "/:id/attachments",
  uploads.array("files", config.uploads.maxFiles),
  asyncHandler(async (request, response) => {
    const chat = await loadChat(request.params.id);
    const files = request.files ?? [];
    if (!files.length) throw badRequest("No files were uploaded");

    const attachments = [];
    const rejected = [];
    for (const file of files) {
      const descriptor = describeAttachment(file.originalname);
      if (!descriptor.supported) {
        rejected.push({ filename: file.originalname, reason: descriptor.reason });
        continue;
      }
      const extraction = extractAttachment(file.buffer, descriptor);
      if (!extraction.ok) {
        rejected.push({ filename: file.originalname, reason: extraction.reason });
        continue;
      }
      const stored = await storeAttachmentBytes({
        buffer: file.buffer,
        chatId: chat._id.toString(),
        handling: extraction.handling,
      });
      const document = await Attachment.create({
        chatId: chat._id.toString(),
        filename: safeUploadFilename(file.originalname),
        contentType: descriptor.contentType,
        extension: descriptor.extension,
        ...(descriptor.label ? { label: descriptor.label } : {}),
        ...(descriptor.language ? { language: descriptor.language } : {}),
        handling: extraction.handling,
        size: file.size,
        ...(extraction.text === null ? {} : { text: extraction.text }),
        ...(extraction.notes?.length ? { notes: extraction.notes } : {}),
        ...stored,
        createdAt: nowIso(),
      });
      attachments.push(document.toJSON());
    }

    // Every file failing is a failed request; a partial success is still a success,
    // because the caller can send what was accepted and see why the rest was not.
    response
      .status(attachments.length ? 201 : 400)
      .json({ attachments, rejected });
  }),
);

chatsRouter.get(
  "/:id/attachments/:attachmentId",
  asyncHandler(async (request, response) => {
    const chat = await loadChat(request.params.id);
    const attachment = await Attachment.findOne({
      _id: requireObjectId(request.params.attachmentId, "attachment"),
      // Scoped to the chat in the URL, so a valid id cannot read another chat's file.
      chatId: chat._id.toString(),
    });
    if (!attachment) {
      throw notFound("No attachment with id " + request.params.attachmentId);
    }
    const bytes = await loadAttachmentBytes(attachment);
    const download = request.query.download === "true";
    response.set({
      "content-type": download
        ? "application/octet-stream"
        : servedContentType(attachment),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${headerFilename(
        attachment.filename,
      )}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // Uploads are user-supplied bytes served from the console's own origin, so
      // nothing they contain is allowed to load, script, or navigate.
      "content-security-policy": "sandbox; default-src 'none'",
    });
    response.send(bytes);
  }),
);

/**
 * What an inline preview is allowed to be labelled as.
 *
 * Images keep their real type so a browser can display them. Everything else is
 * served as plain text no matter what it is: an uploaded .html or .svg served as
 * its own type would be a stored-XSS delivery route through this origin.
 */
function servedContentType(attachment) {
  return attachment.handling === "image"
    ? attachment.contentType
    : "text/plain; charset=utf-8";
}

chatsRouter.patch(
  "/:id",
  asyncHandler(async (request, response) => {
    const input = parseOrThrow(chatUpdateSchema, request.body);
    const chat = await loadChat(request.params.id);
    if (input.title !== undefined) chat.title = input.title;
    if (input.pinned !== undefined) chat.pinned = input.pinned;
    // `updatedAt` is both the sidebar's sort key and its "last activity" label, so
    // renaming or pinning deliberately leaves it alone. Neither is activity, and
    // bumping it would throw an untouched conversation to the top of the list.
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
    // Uploads live in their own collection, so deleting the chat would otherwise
    // orphan them. Unconditional, unlike runs: an attachment has no meaning or
    // route once the chat that owns it is gone.
    const deletedAttachments =
      (await Attachment.deleteMany({ chatId: chat._id.toString() }))
        .deletedCount ?? 0;
    await chat.deleteOne();
    response.json({
      deleted: true,
      id: request.params.id,
      deletedRuns,
      deletedAttachments,
    });
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
  "/:id/context/compact",
  asyncHandler(async (request, response) => {
    const existing = await loadChat(request.params.id);
    const agent = await loadAgent(existing.agentId, { requireEnabled: true });
    const result = await performChatContextCompaction(existing, agent);
    // The full decision remains on the Run and chat records. The normal customer UI
    // needs only the runtime-authoritative occupancy after the operation.
    response.json({ context: result.context });
  }),
);

chatsRouter.post(
  "/:id/messages",
  asyncHandler(async (request, response) => {
    const input = parseOrThrow(chatMessageSchema, request.body);
    const existing = await loadChat(request.params.id);
    const agent = await loadAgent(existing.agentId, { requireEnabled: true });
    const attachments = await claimAttachments(existing, input.attachmentIds);
    const userTimestamp = nowIso();
    const requestId = randomUUID();
    const userMessage = {
      id: randomUUID(),
      role: "user",
      content: input.content,
      createdAt: userTimestamp,
      ...(attachments.length
        ? { attachments: attachments.map(attachmentReference) }
        : {}),
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
    // Bound to the message only once the lease is held, so a rejected turn leaves
    // its uploads unclaimed and available to the retry.
    if (attachments.length) {
      await Attachment.updateMany(
        { _id: { $in: attachments.map((item) => item._id) } },
        { $set: { messageId: userMessage.id } },
      );
    }

    const previousMessages = chat.messages.slice(0, -1);
    const historyStartIndex = chat.session?.historyStartIndex ?? 0;
    // Bounded against the model this agent resolves to, so the runtime's context
    // layer is always the thing that decides a conversation has grown too long.
    // With a fixed bound the console reached its own limit first on any wide model
    // and dropped the opening turns silently — no summary, no compaction event, and
    // a context meter that flattened out well below the threshold the agent had set,
    // which is exactly what "it never auto-compacts" looks like from the outside.
    const contextWindow = await agentContextWindow(agent);
    const sessionHistory = buildSessionHistory(
      previousMessages,
      historyStartIndex,
      historyCharacterLimit(contextWindow),
    );
    const droppedHistory = droppedHistoryCount(
      previousMessages,
      historyStartIndex,
      sessionHistory.length,
    );

    const invocationInput = {
      agentId: chat.agentId,
      prompt: input.content,
      attachments: await attachmentPayloads(attachments),
      runtimeSessionId: chat.runtimeSessionId,
      permissionMode: input.permissionMode,
      includeEvents: input.includeEvents,
      chatId: chat._id.toString(),
      sessionHistory,
      compactContext: input.compactContext,
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

    // Sent before the run so it is not mistaken for something the run did. Reaching
    // this bound means turns were dropped outright rather than summarised, which is
    // the one context outcome the runtime cannot report because it never saw them.
    if (droppedHistory > 0) {
      await writeEvent(response, "warning", {
        type: "warning",
        code: "HISTORY_TRUNCATED",
        message: `This chat is long enough that its ${droppedHistory} oldest turn${droppedHistory === 1 ? " was" : "s were"} left out of the model's view entirely.`,
      });
    }

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

export async function performChatContextCompaction(
  existing,
  agent,
  {
    chatModel = Chat,
    invoke = invokeStoredAgent,
    resolveContextWindow = agentContextWindow,
    requestId = randomUUID(),
    timestamp = nowIso(),
  } = {},
) {
  const previousStatus = idleSessionStatus(existing);
  const leased = await chatModel.findOneAndUpdate(
    {
      _id: existing._id,
      $or: [
        { "session.activeRequestId": { $exists: false } },
        { "session.activeRequestId": null },
        { "session.activeExpiresAt": { $lte: timestamp } },
      ],
    },
    {
      $set: {
        updatedAt: timestamp,
        "session.status": "running",
        "session.activeRequestId": requestId,
        "session.activeExpiresAt": new Date(
          Date.parse(timestamp) + config.agentcore.timeoutMs + 60_000,
        ).toISOString(),
      },
    },
    { new: true },
  );
  if (!leased) {
    throw conflict(
      "This chat already has an operation in progress. Wait for it to finish and retry.",
    );
  }

  const historyStartIndex = leased.session?.historyStartIndex ?? 0;
  const contextWindow = await resolveContextWindow(agent);
  const sessionHistory = buildSessionHistory(
    leased.messages,
    historyStartIndex,
    historyCharacterLimit(contextWindow),
  );

  let invocation;
  try {
    invocation = await invoke({
      operation: "compact",
      agentId: leased.agentId,
      prompt: "",
      runtimeSessionId: leased.runtimeSessionId,
      includeEvents: false,
      chatId: leased._id.toString(),
      sessionHistory,
    });
  } catch (error) {
    await chatModel.findOneAndUpdate(
      { _id: leased._id, "session.activeRequestId": requestId },
      {
        $set: {
          updatedAt: nowIso(),
          "session.status": previousStatus,
          "session.activeRequestId": null,
          "session.activeExpiresAt": null,
        },
      },
    );
    throw error;
  }

  const completedAt = nowIso();
  const context = invocation.result.context;
  const contextIntelligence = invocation.result.contextIntelligence;
  const session = invocation.result.session;
  const updated = await chatModel.findOneAndUpdate(
    { _id: leased._id, "session.activeRequestId": requestId },
    {
      $set: {
        updatedAt: completedAt,
        "session.status": previousStatus,
        "session.origin": session?.origin ?? leased.session?.origin ?? "new",
        "session.storage": session?.storage ?? leased.session?.storage ?? "custom",
        "session.resumed": session?.resumed === true,
        "session.historyMessageCount":
          session?.historyMessageCount ?? leased.messages.length,
        "session.lastActiveAt": completedAt,
        "session.activeRequestId": null,
        "session.activeExpiresAt": null,
        ...(context
          ? { "session.context": { ...context, measuredAt: completedAt } }
          : {}),
        ...(contextIntelligence
          ? { "session.contextIntelligence": contextIntelligence }
          : {}),
      },
    },
    { new: true },
  );
  if (!updated) {
    throw conflict(
      "The chat session lease expired before context compaction was saved.",
    );
  }

  return {
    chat: updated,
    invocation,
    context:
      context && Number.isFinite(context.usedPercent)
        ? { usedPercent: context.usedPercent }
        : null,
  };
}

function idleSessionStatus(chat) {
  const status = chat.session?.status;
  if (["new", "active", "restored", "error"].includes(status)) return status;
  return chat.messages?.length ? "active" : "new";
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
  const title = await autoTitle(chat, invocation);
  const context = invocation.result.context;
  const contextIntelligence = invocation.result.contextIntelligence;
  const updated = await Chat.findOneAndUpdate(
    { _id: chat._id, "session.activeRequestId": requestId },
    {
      $push: { messages: message },
      $set: {
        ...(title ? { title } : {}),
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
        // Only written when the runtime measured it, so a runtime without the
        // context layer leaves whatever was last known in place rather than
        // clearing the meter to zero.
        ...(context
          ? { "session.context": { ...context, measuredAt: timestamp } }
          : {}),
        ...(contextIntelligence
          ? { "session.contextIntelligence": contextIntelligence }
          : {}),
      },
      // A missing report on a completed turn means the latest runtime/agent did
      // not run Context Intelligence. Remove the previous turn's report instead of
      // presenting stale decisions as if they produced the new answer.
      ...(contextIntelligence
        ? {}
        : { $unset: { "session.contextIntelligence": "" } }),
    },
    { new: true },
  );
  if (!updated)
    throw conflict(
      "The chat session lease expired before the result was saved.",
    );
  return updated;
}

/**
 * Resolves the ids a message claims into the uploads they name.
 *
 * Every id has to belong to this chat and be unclaimed. That rejects an id from
 * another conversation, an id already sent with an earlier message, and an id that
 * was never issued — all with one lookup, rather than trusting the client's list.
 */
async function claimAttachments(chat, ids) {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    throw badRequest("The same attachment was listed more than once");
  }
  const found = await Attachment.find({
    _id: { $in: unique.map((id) => requireObjectId(id, "attachment")) },
    chatId: chat._id.toString(),
    // Matches both an explicit null and a document that has never been sent,
    // which is how MongoDB treats a null equality check on a missing field.
    messageId: null,
  });
  if (found.length !== unique.length) {
    throw badRequest(
      "One or more attachments are unknown, belong to another chat, or were " +
        "already sent with an earlier message",
    );
  }
  // Client order is presentation order, which Mongo does not preserve.
  const byId = new Map(found.map((item) => [item._id.toString(), item]));
  const ordered = unique.map((id) => byId.get(id));

  const totalChars = ordered.reduce(
    (total, item) => total + (item.text?.length ?? 0),
    0,
  );
  if (totalChars > config.uploads.maxPromptChars) {
    throw badRequest(
      `These attachments contain ${totalChars.toLocaleString()} characters of text, ` +
        `over the ${config.uploads.maxPromptChars.toLocaleString()} character limit for ` +
        "one message. Send fewer files or split them across messages.",
    );
  }
  return ordered;
}

/** The bounded copy stored on the message, without the text or the bytes. */
function attachmentReference(attachment) {
  return {
    id: attachment._id.toString(),
    filename: attachment.filename,
    contentType: attachment.contentType,
    handling: attachment.handling,
    ...(attachment.label ? { label: attachment.label } : {}),
    ...(attachment.language ? { language: attachment.language } : {}),
    size: attachment.size,
    textChars: attachment.text?.length ?? 0,
    downloadable: Boolean(attachment.content || attachment.storage),
    ...(attachment.notes?.length ? { notes: attachment.notes } : {}),
  };
}

/**
 * The attachments as the harness takes them.
 *
 * Text is already extracted and travels as text. Image bytes are read now, because
 * only the model needs them and only for this turn — they are never stored in the
 * transcript the console keeps.
 */
async function attachmentPayloads(attachments) {
  const payloads = [];
  for (const attachment of attachments) {
    if (attachment.handling === "image") {
      const bytes = await loadAttachmentBytes(attachment);
      payloads.push({
        kind: "image",
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        data: bytes.toString("base64"),
      });
      continue;
    }
    payloads.push({
      kind: "text",
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      ...(attachment.language ? { language: attachment.language } : {}),
      text: attachment.text ?? "",
      ...(attachment.notes?.length ? { notes: attachment.notes } : {}),
    });
  }
  return payloads;
}

/**
 * Names a chat the first time it has something to be named after.
 *
 * Keyed on the title still being a placeholder rather than on the message count,
 * so a first turn that failed before producing an answer gets another chance on
 * the next one instead of leaving the chat called "<agent> chat" for good. A chat
 * the user has renamed never matches, so it is never silently retitled.
 */
async function autoTitle(chat, invocation) {
  if (!hasDefaultTitle(chat)) return null;
  const prompt = chat.messages?.find(
    (message) => message.role === "user",
  )?.content;
  if (!prompt) return null;
  return generateChatTitle({
    provider: invocation.resolved?.modelProvider?.value,
    prompt,
    reply: invocation.result?.output ?? "",
  });
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

/**
 * The context window of the model an agent resolves to, or `undefined`.
 *
 * Read here rather than taken from the payload because the history bound is applied
 * before the payload is built. Failure is not fatal: an unresolvable provider falls
 * back to the hard backstop, and the invocation that follows will report the real
 * problem far better than a history bound could.
 */
async function agentContextWindow(agent) {
  try {
    const provider = await loadModelProvider(agent.modelProviderId);
    return provider?.capabilities?.contextWindow;
  } catch {
    return undefined;
  }
}

function chatDetail(chat) {
  return chat.toJSON();
}

/**
 * The absolute ceiling on a replayed transcript, whatever the model can hold.
 *
 * A transport backstop, not a context policy: it exists so one enormous chat cannot
 * build an unbounded request body, and it is deliberately far above what any
 * realistic model window makes reachable. The 4 characters per token is the same
 * ratio the runtime's estimator uses, so the two layers reason in one unit.
 */
const HISTORY_HARD_CHARACTER_LIMIT = 8_000_000;
const HISTORY_HARD_MESSAGE_LIMIT = 5_000;
const CHARACTERS_PER_TOKEN = 4;

/**
 * How many characters of history to replay for a model of a given window.
 *
 * Sized *above* the window rather than below it, because the runtime's context layer
 * is what decides when a conversation is too long — it summarises the older half and
 * says so on a `context.compaction.completed` event. Anything this function drops is
 * gone silently instead, with no summary and no notice, so the bound has to stay out
 * of the runtime's way and only catch the pathological case.
 *
 * Twice the window is the margin: the runtime compacts at a percentage of the window
 * less its reserved reply, so at 2x the whole window the threshold is always crossed
 * first and compaction always gets to be the mechanism.
 */
export function historyCharacterLimit(contextWindow) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return HISTORY_HARD_CHARACTER_LIMIT;
  }
  return Math.min(
    HISTORY_HARD_CHARACTER_LIMIT,
    Math.ceil(contextWindow * CHARACTERS_PER_TOKEN * 2),
  );
}

/**
 * The stored turns that are eligible for replay at all.
 *
 * Split out so the bound and the count of what the bound dropped are derived from
 * one definition of "replayable" rather than two that can drift.
 */
function replayableHistory(messages, startIndex) {
  return messages
    .slice(startIndex)
    .map((message) => ({ message, text: historyText(message) }))
    .filter(
      ({ message, text }) =>
        (message.role === "user" || message.role === "assistant") &&
        text.length > 0,
    );
}

/** How many replayable turns the bound left out, for the caller's warning. */
export function droppedHistoryCount(
  messages,
  startIndex = 0,
  replayedCount = 0,
) {
  return Math.max(
    0,
    replayableHistory(messages, startIndex).length - replayedCount,
  );
}

export function buildSessionHistory(
  messages,
  startIndex = 0,
  maximum = HISTORY_HARD_CHARACTER_LIMIT,
  maximumMessages = HISTORY_HARD_MESSAGE_LIMIT,
) {
  const previous = replayableHistory(messages, startIndex);
  const selected = [];
  let size = 0;
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const { message, text } = previous[index];
    if (selected.length >= maximumMessages) break;
    if (size + text.length > maximum) break;
    selected.unshift({
      id: message.id,
      role: message.role,
      content: text,
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    });
    size += text.length;
  }
  return selected;
}

/**
 * What a stored message contributes to a replayed transcript.
 *
 * This history is only read when the runtime's own transcript is missing, and it is
 * text-only by design. A turn that sent files with no words would otherwise vanish
 * from the replay entirely, so it is recorded as what it carried.
 */
function historyText(message) {
  if (typeof message.content === "string" && message.content.length > 0) {
    return message.content;
  }
  const attachments = message.attachments ?? [];
  if (!attachments.length) return "";
  const names = attachments.map((attachment) => attachment.filename).join(", ");
  return `[sent ${attachments.length} file${attachments.length === 1 ? "" : "s"}: ${names}]`;
}

function headerFilename(value) {
  const safe = String(value ?? "document")
    .replace(/[\x00-\x1F\x7F"\\]/g, "_")
    .trim();
  return safe || "document";
}

import mongoose from "mongoose";

const artifactStorageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["s3"], required: true },
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    region: String,
    versionId: String,
    etag: String,
    checksumSha256: String,
  },
  { _id: false },
);

const artifactSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    kind: {
      type: String,
      enum: [
        "markdown",
        "html",
        "docx",
        "xlsx",
        "csv",
        "json",
        "ndjson",
        "code",
      ],
    },
    // Set only for `code`, whose extension and highlighting depend on it.
    language: String,
    title: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    createdAt: { type: String, required: true },
    // `content` is legacy/local compatibility. New production generated files
    // keep only an S3 reference in MongoDB.
    content: String,
    storage: { type: artifactStorageSchema },
  },
  { _id: false },
);

const toolCallSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    input: { type: String, default: "" },
    output: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "running", "done", "error"],
      required: true,
    },
  },
  { _id: false },
);

/**
 * An uploaded file as it appears on the message that sent it.
 *
 * A reference, not the file: the bytes and the extracted text live in the
 * `chat_attachments` collection so a transcript stays cheap to read.
 */
const messageAttachmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    handling: { type: String, enum: ["text", "image"], required: true },
    label: String,
    language: String,
    size: { type: Number, required: true },
    textChars: Number,
    downloadable: Boolean,
    notes: { type: [String], default: undefined },
  },
  { _id: false },
);

const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "assistant", "error"],
      required: true,
    },
    // Empty for a turn that sent files with no words. Mongoose treats "" as
    // missing for a required String, so the requirement lives in the zod layer,
    // which can see the attachments and judge the message as a whole.
    content: { type: String, default: "" },
    reasoning: String,
    attachments: { type: [messageAttachmentSchema], default: undefined },
    artifacts: { type: [artifactSchema], default: undefined },
    toolCalls: { type: [toolCallSchema], default: undefined },
    // Application metadata for a terminal Context Intelligence decision. It is
    // deliberately not assistant prose and is excluded from replay history.
    intervention: mongoose.Schema.Types.Mixed,
    runId: String,
    createdAt: { type: String, required: true },
    error: {
      code: String,
      message: String,
      recoverable: Boolean,
    },
  },
  { _id: false },
);

const sessionSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["new", "running", "active", "restored", "error"],
      default: "new",
    },
    storage: {
      type: String,
      enum: ["none", "memory", "file", "s3", "custom"],
    },
    generation: { type: Number, default: 1 },
    historyStartIndex: { type: Number, default: 0 },
    origin: {
      type: String,
      enum: ["new", "store", "client_history", "stateless"],
      default: "new",
    },
    resumed: { type: Boolean, default: false },
    historyMessageCount: { type: Number, default: 0 },
    lastActiveAt: String,
    activeRequestId: String,
    activeExpiresAt: String,
    /**
     * Where the model context stood at the end of the last turn, so a reopened
     * chat shows its usage meter without having to replay a run. Written from the
     * harness `context.usage` event; absent for chats that predate it.
     */
    context: {
      type: new mongoose.Schema(
        {
          usedTokens: Number,
          budgetTokens: Number,
          contextWindow: Number,
          reservedOutputTokens: Number,
          usedPercent: Number,
          compacted: Boolean,
          compactions: Number,
          peakTokens: Number,
          peakPercent: Number,
          measuredAt: String,
          // The context inspector's stored half: what the layer did on the last turn
          // and what it did across the run, so reopening a chat shows the same
          // explanation the live view showed rather than a bare percentage.
          pressure: String,
          action: String,
          strategy: String,
          verification: String,
          preserved: [String],
          compressed: [String],
          recoveries: Number,
          state: mongoose.Schema.Types.Mixed,
          timeline: [mongoose.Schema.Types.Mixed],
        },
        { _id: false, strict: false },
      ),
    },
    /** Last content-free Context Intelligence report, for a reopened chat. */
    contextIntelligence: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const chatSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    pinned: { type: Boolean, default: false },
    agentId: { type: String, required: true, index: true },
    agentName: { type: String, required: true },
    runtimeSessionId: { type: String, required: true },
    session: { type: sessionSchema, default: () => ({}) },
    messages: { type: [chatMessageSchema], default: [] },
    lastMessageAt: String,
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: "chats",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

chatSchema.index({ updatedAt: -1 });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  plain.messageCount = plain.messages?.length ?? 0;
  plain.messages = plain.messages?.map((message) => ({
    ...message,
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            ...attachment,
            ...(attachment.downloadable
              ? {
                  url: `/api/chats/${plain.id}/attachments/${encodeURIComponent(attachment.id)}`,
                  downloadUrl:
                    `/api/chats/${plain.id}/attachments/${encodeURIComponent(attachment.id)}` +
                    "?download=true",
                }
              : {}),
          })),
        }
      : {}),
    ...(message.artifacts?.length
      ? {
          artifacts: message.artifacts.map(
            ({ content: _content, storage: _storage, ...artifact }) => ({
              ...artifact,
              url: `/api/chats/${plain.id}/artifacts/${encodeURIComponent(artifact.id)}`,
              downloadUrl:
                `/api/chats/${plain.id}/artifacts/${encodeURIComponent(artifact.id)}` +
                "?download=true",
            }),
          ),
        }
      : {}),
  }));
  delete plain._id;
  return plain;
}

export const Chat = mongoose.models.Chat ?? mongoose.model("Chat", chatSchema);

/**
 * Lists chat metadata without hydrating every stored transcript. The computed
 * count keeps list/dashboard responses useful while MongoDB leaves the large
 * messages array on the server.
 */
export function chatSummaries(filter = {}, limit = 50) {
  return Chat.aggregate([
    { $match: filter },
    // Projected before the sort, so ordering never carries stored transcripts
    // through it. Pinned chats lead, and each group stays newest-first.
    {
      $project: {
        _id: 0,
        id: { $toString: "$_id" },
        title: 1,
        // Chats created before pinning existed have no field to sort on, and a
        // missing value sorts as its own group — which would split the unpinned
        // chats into two separately ordered blocks.
        pinned: { $ifNull: ["$pinned", false] },
        agentId: 1,
        agentName: 1,
        runtimeSessionId: 1,
        // The list needs session health and the small occupancy meter, not the
        // multi-section Context Intelligence report. The selected chat fetches its
        // full document, avoiding the report being repeated for every sidebar row.
        session: {
          status: "$session.status",
          storage: "$session.storage",
          generation: "$session.generation",
          historyStartIndex: "$session.historyStartIndex",
          origin: "$session.origin",
          resumed: "$session.resumed",
          historyMessageCount: "$session.historyMessageCount",
          lastActiveAt: "$session.lastActiveAt",
          activeRequestId: "$session.activeRequestId",
          activeExpiresAt: "$session.activeExpiresAt",
          context: "$session.context",
        },
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
        messageCount: { $size: { $ifNull: ["$messages", []] } },
      },
    },
    { $sort: { pinned: -1, updatedAt: -1 } },
    { $limit: limit },
  ]);
}

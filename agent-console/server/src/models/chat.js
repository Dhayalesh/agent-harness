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
      enum: ["markdown", "html", "docx", "xlsx", "csv"],
    },
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

const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "assistant", "error"],
      required: true,
    },
    content: { type: String, required: true },
    reasoning: String,
    artifacts: { type: [artifactSchema], default: undefined },
    toolCalls: { type: [toolCallSchema], default: undefined },
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
  },
  { _id: false },
);

const chatSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
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
    { $sort: { updatedAt: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        id: { $toString: "$_id" },
        title: 1,
        agentId: 1,
        agentName: 1,
        runtimeSessionId: 1,
        session: 1,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
        messageCount: { $size: { $ifNull: ["$messages", []] } },
      },
    },
  ]);
}

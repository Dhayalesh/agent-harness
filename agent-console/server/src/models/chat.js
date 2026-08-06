import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "assistant", "error"],
      required: true,
    },
    content: { type: String, required: true },
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

const chatSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    agentId: { type: String, required: true, index: true },
    agentName: { type: String, required: true },
    runtimeSessionId: { type: String, required: true },
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
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
        messageCount: { $size: { $ifNull: ["$messages", []] } },
      },
    },
  ]);
}

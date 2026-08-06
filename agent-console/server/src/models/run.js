import mongoose from "mongoose";

const usageSchema = new mongoose.Schema(
  {
    inputTokens: Number,
    outputTokens: Number,
    totalTokens: Number,
    cacheReadTokens: Number,
    cacheWriteTokens: Number,
    estimatedCostUsd: Number,
  },
  { _id: false, strict: false },
);

const toolSummarySchema = new mongoose.Schema(
  { name: String, calls: Number, errors: Number },
  { _id: false, suppressReservedKeysWarning: true },
);

const runSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, index: true },
    agentName: { type: String, required: true },
    chatId: { type: String, index: true },
    prompt: { type: String, required: true },
    status: {
      type: String,
      enum: ["running", "success", "error"],
      default: "running",
      index: true,
    },
    output: { type: String, default: "" },
    stopReason: String,
    turns: { type: Number, default: 0 },
    usage: { type: usageSchema, default: () => ({}) },
    tools: { type: [toolSummarySchema], default: [] },
    agentRuntimeArn: String,
    agentRuntimeQualifier: String,
    runtimeSessionId: String,
    traceId: String,
    harnessSessionId: String,
    workingDirectory: String,
    durationMs: Number,
    error: {
      code: String,
      message: String,
      recoverable: Boolean,
    },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  {
    collection: "runs",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

runSchema.index({ createdAt: -1 });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  delete plain._id;
  return plain;
}

export const Run = mongoose.models.Run ?? mongoose.model("Run", runSchema);

/** Run-list projection: keep the table useful without transferring up to 2MB
 * of replay prompt (or the full output) for each row. Detail fetches stay full. */
export function runSummaries(filter = {}, limit = 50, sortDirection = -1) {
  return Run.aggregate([
    { $match: filter },
    { $sort: { createdAt: sortDirection } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        id: { $toString: "$_id" },
        agentId: 1,
        agentName: 1,
        chatId: 1,
        prompt: { $substrCP: [{ $ifNull: ["$prompt", ""] }, 0, 240] },
        status: 1,
        stopReason: 1,
        turns: 1,
        usage: 1,
        tools: 1,
        agentRuntimeArn: 1,
        agentRuntimeQualifier: 1,
        runtimeSessionId: 1,
        traceId: 1,
        harnessSessionId: 1,
        workingDirectory: 1,
        durationMs: 1,
        error: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
}

import mongoose from "mongoose";

const usageSchema = new mongoose.Schema(
  {
    inputTokens: Number,
    outputTokens: Number,
    totalTokens: Number,
    cacheReadTokens: Number,
    cacheWriteTokens: Number,
    reasoningTokens: Number,
  },
  { _id: false, strict: false },
);

const toolSummarySchema = new mongoose.Schema(
  { name: String, calls: Number, errors: Number },
  { _id: false, suppressReservedKeysWarning: true },
);

/**
 * How full the model context was when this run ended.
 *
 * `budgetTokens` is the effective input budget — the window less the reserved
 * reply and the safety margin — so `usedPercent` is a fraction of what the run
 * was allowed to spend rather than of the raw window.
 */
const contextUsageSchema = new mongoose.Schema(
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
    /**
     * What the runtime's context layer decided, when it reported it.
     *
     * Named rather than left to `strict: false` so the fields are typed on read and
     * so this schema documents the shape a client can rely on. Still non-strict,
     * because a newer runtime reporting a field this console has not learned about
     * should be stored, not dropped.
     */
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
);

const runSchema = new mongoose.Schema(
  {
    agentId: { type: String, required: true, index: true },
    agentName: { type: String, required: true },
    modelProviderId: String,
    modelProviderName: String,
    skillRouting: { type: mongoose.Schema.Types.Mixed },
    provider: String,
    model: String,
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
    usageDetails: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    context: { type: contextUsageSchema },
    tools: { type: [toolSummarySchema], default: [] },
    artifacts: { type: [mongoose.Schema.Types.Mixed], default: [] },
    agentRuntimeArn: String,
    agentRuntimeQualifier: String,
    runtimeSessionId: String,
    traceId: String,
    harnessSessionId: String,
    session: { type: mongoose.Schema.Types.Mixed },
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
  plain.artifacts = plain.artifacts?.map(
    ({ content: _content, storage: _storage, ...artifact }) => artifact,
  );
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
        modelProviderId: 1,
        modelProviderName: 1,
        provider: 1,
        model: 1,
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
        session: 1,
        workingDirectory: 1,
        durationMs: 1,
        error: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ]);
}

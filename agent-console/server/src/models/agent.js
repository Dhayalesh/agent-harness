import mongoose from "mongoose";

const skillReferenceSchema = new mongoose.Schema(
  {
    skillId: { type: String, required: true },
    allowedTools: { type: [String], default: undefined },
  },
  { _id: false },
);

const limitsSchema = new mongoose.Schema(
  {
    maxTurns: { type: Number, required: true },
    maxOutputTokens: Number,
    maxInputTokens: Number,
  },
  { _id: false },
);

const agentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: String,
    systemPrompt: { type: String, required: true },
    modelProviderId: { type: String, required: true, index: true },
    model: String,
    tools: { type: [String], default: [] },
    skills: { type: [skillReferenceSchema], default: [] },
    mcpServerIds: { type: [String], default: [] },
    limits: { type: limitsSchema, required: true },
    // Historical records predate this field; the default fills it on hydration so
    // they stay valid without a migration.
    stream: { type: Boolean, required: true, default: false },
    enabled: { type: Boolean, required: true, default: true, index: true },
    isDefault: Boolean,
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, required: true },
  },
  {
    collection: "agents",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

agentSchema.index({ name: 1 }, { unique: true });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  delete plain._id;
  return plain;
}

export const Agent = mongoose.models.Agent ?? mongoose.model("Agent", agentSchema);

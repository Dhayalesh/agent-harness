import mongoose from "mongoose";

const mcpServerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    transport: { type: String, required: true },
    command: String,
    // Keep an omitted args field truly absent. Mongoose otherwise materializes []
    // on every document, which makes an HTTP record fail the harness invariant
    // that process-only fields are omitted.
    args: { type: [String], default: undefined },
    env: { type: mongoose.Schema.Types.Mixed, select: false },
    url: String,
    apiKey: { type: String, select: false },
    auth: { type: mongoose.Schema.Types.Mixed, required: true },
    capabilities: { type: mongoose.Schema.Types.Mixed, required: true },
    wire: mongoose.Schema.Types.Mixed,
    headers: { type: mongoose.Schema.Types.Mixed, select: false },
    enabled: { type: Boolean, required: true, default: true, index: true },
    autoConnect: Boolean,
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, required: true },
  },
  {
    collection: "mcp_servers",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

mcpServerSchema.index({ name: 1 }, { unique: true });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  plain.hasApiKey = typeof plain.apiKey === "string" && plain.apiKey.length > 0;
  plain.hasEnv = Boolean(plain.env && Object.keys(plain.env).length);
  plain.envKeys = Object.keys(plain.env ?? {}).sort();
  plain.hasHeaders = Boolean(plain.headers && Object.keys(plain.headers).length);
  plain.headerNames = Object.keys(plain.headers ?? {}).sort();
  delete plain._id;
  delete plain.apiKey;
  delete plain.env;
  delete plain.headers;
  return plain;
}

export const McpServer =
  mongoose.models.McpServer ?? mongoose.model("McpServer", mcpServerSchema);

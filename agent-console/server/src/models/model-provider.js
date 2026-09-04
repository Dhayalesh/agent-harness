import mongoose from "mongoose";

const modelProviderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    baseURL: String,
    apiKey: { type: String, select: false },
    auth: { type: mongoose.Schema.Types.Mixed, required: true },
    capabilities: { type: mongoose.Schema.Types.Mixed, required: true },
    wire: mongoose.Schema.Types.Mixed,
    headers: { type: mongoose.Schema.Types.Mixed, select: false },
    enabled: { type: Boolean, required: true, default: true, index: true },
    isDefault: Boolean,
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, required: true },
  },
  {
    collection: "model_providers",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

modelProviderSchema.index({ name: 1 }, { unique: true });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  plain.hasApiKey = typeof plain.apiKey === "string" && plain.apiKey.length > 0;
  plain.hasHeaders = Boolean(plain.headers && Object.keys(plain.headers).length);
  plain.headerNames = Object.keys(plain.headers ?? {}).sort();
  delete plain._id;
  delete plain.apiKey;
  delete plain.headers;
  return plain;
}

export const ModelProvider =
  mongoose.models.ModelProvider ??
  mongoose.model("ModelProvider", modelProviderSchema);

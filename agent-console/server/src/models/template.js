import mongoose from "mongoose";

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    uri: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true, index: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    createdBy: { type: String, required: true },
  },
  {
    collection: "templates",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

templateSchema.index({ name: 1 }, { unique: true });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  delete plain._id;
  return plain;
}

export const Template =
  mongoose.models.Template ?? mongoose.model("Template", templateSchema);

import mongoose from "mongoose";

const storageSchema = new mongoose.Schema(
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

/**
 * An uploaded file, stored apart from its chat.
 *
 * Its own collection rather than a subdocument: a chat already carries its whole
 * transcript, and folding megabytes of upload into that document would push it
 * toward the 16 MB BSON limit and make every chat read more expensive.
 *
 * `text` is the extracted content that actually reaches the model. `content` and
 * `storage` hold the original bytes for download, and exactly one of them is set —
 * or neither, when the file was too large to keep without S3 configured.
 */
const attachmentSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, index: true },
    /** Set when the attachment is sent with a message, so orphans stay findable. */
    messageId: String,
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    extension: { type: String, required: true },
    label: String,
    /** Highlighting hint for text uploads, and the fence label sent to the model. */
    language: String,
    handling: { type: String, enum: ["text", "image"], required: true },
    size: { type: Number, required: true },
    text: String,
    /** What extraction had to do to the file, shown next to the attachment. */
    notes: { type: [String], default: undefined },
    content: Buffer,
    storage: { type: storageSchema },
    createdAt: { type: String, required: true },
  },
  {
    collection: "chat_attachments",
    strict: true,
    versionKey: false,
    toJSON: { transform: transformDocument },
  },
);

attachmentSchema.index({ chatId: 1, createdAt: -1 });

function transformDocument(_document, plain) {
  plain.id = plain._id.toString();
  // The extracted text and the bytes are both potentially large, and neither is
  // needed to render a chip. `textChars` is what the UI reports instead.
  plain.textChars = typeof plain.text === "string" ? plain.text.length : 0;
  plain.downloadable = Boolean(plain.content || plain.storage);
  if (plain.downloadable) {
    const base = `/api/chats/${plain.chatId}/attachments/${encodeURIComponent(plain.id)}`;
    plain.url = base;
    plain.downloadUrl = `${base}?download=true`;
  }
  delete plain.text;
  delete plain.content;
  delete plain.storage;
  delete plain._id;
  return plain;
}

export const Attachment =
  mongoose.models.Attachment ??
  mongoose.model("Attachment", attachmentSchema);

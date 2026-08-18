import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { badGateway, notFound } from "../lib/http-error.js";

const clients = new Map();

/**
 * Where an upload's original bytes live.
 *
 * S3 when the console is configured for it, otherwise inside the attachment
 * document. The inline path exists so the feature works on a laptop with nothing
 * but MongoDB, and it is bounded well under the BSON document limit.
 *
 * A file too large to keep either way still becomes an attachment: the extracted
 * text is what the model reads, so the upload is useful even when the original
 * cannot be offered back for download.
 */
export async function storeAttachmentBytes({ buffer, chatId, handling }) {
  if (config.artifacts.bucket) {
    return { storage: await putObject({ buffer, chatId }) };
  }
  // An image is only useful if its bytes survive, since they are what reaches the
  // model. Text uploads have already been reduced to their extracted content.
  const limit =
    handling === "image"
      ? config.uploads.maxImageBytes
      : config.uploads.maxInlineBytes;
  if (buffer.byteLength <= limit) return { content: buffer };
  return {};
}

async function putObject({ buffer, chatId }) {
  const bucket = config.artifacts.bucket;
  const prefix = config.uploads.prefix;
  // Format-neutral, and scoped by chat so a chat's uploads can be swept together.
  const key = `${prefix}/${encodeURIComponent(chatId)}/${randomUUID()}/content`;
  const checksum = createHash("sha256").update(buffer).digest("base64");
  const client = clientFor(config.artifacts.region);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.artifacts.requestTimeoutMs,
  );
  timer.unref?.();
  try {
    const output = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ServerSideEncryption: "AES256",
        ChecksumSHA256: checksum,
        // Uploads are immutable; a retry must not silently replace a key.
        IfNoneMatch: "*",
      }),
      { abortSignal: controller.signal },
    );
    return {
      kind: "s3",
      bucket,
      key,
      ...(config.artifacts.region ? { region: config.artifacts.region } : {}),
      ...(output.ETag ? { etag: output.ETag } : {}),
      checksumSha256: checksum,
    };
  } catch (error) {
    throw badGateway("Unable to store the upload in S3", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads an upload's bytes after the route has resolved the owning chat.
 *
 * Deliberately a separate allowlist from `loadArtifactBody`: an artifact reference
 * must not be able to name an upload key, and an upload reference must not be able
 * to name an artifact key, even though both live in one bucket.
 */
export async function loadAttachmentBytes(attachment) {
  if (Buffer.isBuffer(attachment?.content)) return attachment.content;
  const storage = attachment?.storage;
  if (storage?.kind !== "s3") {
    throw notFound("This attachment's original file is no longer available");
  }
  if (!config.artifacts.bucket) {
    throw badGateway("S3 upload access is not configured on agent-console");
  }
  if (storage.bucket !== config.artifacts.bucket) {
    throw badGateway("The attachment references a bucket this console does not allow");
  }
  if (!storage.key.startsWith(`${config.uploads.prefix}/`)) {
    throw badGateway("The attachment references an S3 prefix this console does not allow");
  }

  const client = clientFor(storage.region || config.artifacts.region);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.artifacts.requestTimeoutMs,
  );
  timer.unref?.();
  try {
    const output = await client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: storage.key,
        ...(storage.versionId ? { VersionId: storage.versionId } : {}),
      }),
      { abortSignal: controller.signal },
    );
    if (!output.Body) throw badGateway("S3 returned an empty attachment body");
    const bytes = await bodyBytes(output.Body, config.uploads.maxFileBytes);
    if (storage.checksumSha256) {
      const actual = createHash("sha256").update(bytes).digest("base64");
      if (actual !== storage.checksumSha256) {
        throw badGateway("Stored attachment checksum does not match its reference");
      }
    }
    return bytes;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      throw notFound("Attachment object was not found in S3");
    }
    throw badGateway("Unable to read the attachment from S3", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

function clientFor(region) {
  const key = region ?? "";
  if (!clients.has(key)) {
    clients.set(key, new S3Client({ ...(region ? { region } : {}) }));
  }
  return clients.get(key);
}

async function bodyBytes(body, maximum) {
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maximum) {
      throw badGateway("Stored attachment exceeds the size limit");
    }
    return Buffer.from(bytes);
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maximum) {
        throw badGateway("Stored attachment exceeds the size limit");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw badGateway("S3 returned an unsupported attachment body");
}

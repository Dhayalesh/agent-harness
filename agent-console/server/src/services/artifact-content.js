import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { badGateway, notFound } from "../lib/http-error.js";

const clients = new Map();

/** Loads bytes only after the chat route has resolved the owning chat and reference. */
export async function loadArtifactBody(artifact, options = {}) {
  if (typeof artifact?.content === "string") {
    return Buffer.from(artifact.content, "utf8");
  }
  const storage = artifact?.storage;
  if (storage?.kind !== "s3") throw notFound("Artifact content is unavailable");
  if (!config.artifacts.bucket) {
    throw badGateway("S3 artifact access is not configured on agent-console");
  }
  if (storage.bucket !== config.artifacts.bucket) {
    throw badGateway(
      "The artifact references a bucket this console does not allow",
    );
  }
  if (
    config.artifacts.prefix &&
    !storage.key.startsWith(`${config.artifacts.prefix}/`)
  ) {
    throw badGateway(
      "The artifact references an S3 prefix this console does not allow",
    );
  }

  const client =
    options.client ?? clientFor(storage.region || config.artifacts.region);
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
        ChecksumMode: "ENABLED",
      }),
      { abortSignal: controller.signal },
    );
    if (!output.Body) throw badGateway("S3 returned an empty artifact body");
    if (
      output.ContentLength !== undefined &&
      output.ContentLength > config.artifacts.maxBytes
    ) {
      throw badGateway("Stored artifact exceeds the configured size limit");
    }
    const bytes = await bodyBytes(output.Body, config.artifacts.maxBytes);
    if (
      storage.checksumSha256 &&
      output.ChecksumSHA256 &&
      storage.checksumSha256 !== output.ChecksumSHA256
    ) {
      throw badGateway("Stored artifact checksum does not match its reference");
    }
    return Buffer.from(bytes);
  } catch (error) {
    if (error?.status) throw error;
    if (isNotFound(error))
      throw notFound("Artifact object was not found in S3");
    throw badGateway("Unable to read the artifact from S3", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

function clientFor(region) {
  const key = region ?? "";
  if (!clients.has(key)) {
    clients.set(
      key,
      new S3Client({
        ...(region ? { region } : {}),
      }),
    );
  }
  return clients.get(key);
}

async function bodyBytes(body, maximum) {
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > maximum)
      throw badGateway("Stored artifact exceeds the size limit");
    return bytes;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maximum)
        throw badGateway("Stored artifact exceeds the size limit");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw badGateway("S3 returned an unsupported artifact body");
}

function isNotFound(error) {
  return (
    error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404
  );
}

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { badGateway, badRequest, notFound } from "../lib/http-error.js";
import { parseS3Uri } from "./skill-content.js";

const clients = new Map();

export function templateContentUri(name) {
  assertConfigured();
  return `s3://${config.templates.bucket}/${config.templates.prefix}/${name}.md`;
}

export async function storeTemplateContent(
  name,
  content,
  { overwrite = false } = {},
) {
  const uri = templateContentUri(name);
  const { bucket, key } = parseS3Uri(uri, `template ${name}`);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > config.templates.maxBytes) {
    throw badRequest(
      `Template content must be at most ${config.templates.maxBytes.toLocaleString()} UTF-8 bytes`,
    );
  }

  await send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "text/markdown; charset=utf-8",
      ServerSideEncryption: "AES256",
      ...(overwrite ? {} : { IfNoneMatch: "*" }),
    }),
    "store the template in S3",
  );
  return uri;
}
export async function loadTemplateContent(uri, context = "template") {
  assertConfigured();
  const location = parseS3Uri(uri, context);
  let output;
  try {
    output = await sendRaw(
      new GetObjectCommand({ Bucket: location.bucket, Key: location.key }),
    );
    if (
      Number.isFinite(output.ContentLength) &&
      output.ContentLength > config.templates.maxBytes
    ) {
      throw badGateway("Stored template exceeds the size limit");
    }
    if (!output.Body) throw badGateway("S3 returned an empty template body");
    return (await bodyBytes(output.Body, config.templates.maxBytes)).toString("utf8");
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      throw notFound("Template document was not found in S3");
    }
    throw storageFailure("read the template from S3", error);
  }
}

export async function deleteManagedTemplateContent(uri) {
  if (!config.templates.bucket) return false;
  const location = parseS3Uri(uri, "template");
  if (!isManagedLocation(location)) return false;
  await send(
    new DeleteObjectCommand({
      Bucket: location.bucket,
      Key: location.key,
    }),
    "delete the template from S3",
  );
  return true;
}

function isManagedLocation({ bucket, key }) {
  return (
    bucket === config.templates.bucket &&
    key.startsWith(`${config.templates.prefix}/`) &&
    key.endsWith(".md")
  );
}

function assertConfigured() {
  if (!config.templates.bucket) {
    throw badGateway(
      "Template storage is not configured. Set AGENT_SESSION_S3_BUCKET in agent-console/server/.env.",
    );
  }
}
async function send(command, action) {
  try {
    return await sendRaw(command);
  } catch (error) {
    if (error?.status) throw error;
    throw storageFailure(action, error);
  }
}

async function sendRaw(command) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.templates.requestTimeoutMs,
  );
  timer.unref?.();
  try {
    return await clientFor(config.templates.region).send(command, {
      abortSignal: controller.signal,
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
      throw badGateway("Stored template exceeds the size limit");
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
        throw badGateway("Stored template exceeds the size limit");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw badGateway("S3 returned an unsupported template body");
}

function storageFailure(action, error) {
  return badGateway(`Unable to ${action}`, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

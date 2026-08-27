import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { badGateway, badRequest, notFound } from "../lib/http-error.js";

const clients = new Map();

export function parseS3Uri(value, context = "skill") {
  const uri = String(value ?? "").trim();
  if (uri.startsWith("s3://")) {
    const rest = uri.slice(5);
    const separator = rest.indexOf("/");
    if (separator <= 0) throw badRequest(context + " has an invalid S3 URI.");
    return checked(rest.slice(0, separator), rest.slice(separator + 1), context);
  }
  let url;
  try {
    url = new URL(uri);
  } catch {
    throw badRequest(context + " has an invalid S3 URI.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw badRequest(context + " must use an uncredentialed S3 URI.");
  }
  let key;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw badRequest(context + " has an invalid S3 URI.");
  }
  const hosted = url.hostname.match(/^(.+)\.s3(?:[.-][^.]+)?\.amazonaws\.com$/);
  if (hosted?.[1]) return checked(hosted[1], key, context);
  if (/^s3(?:[.-][^.]+)?\.amazonaws\.com$/.test(url.hostname)) {
    const separator = key.indexOf("/");
    if (separator > 0) {
      return checked(key.slice(0, separator), key.slice(separator + 1), context);
    }
  }
  throw badRequest(context + " must point to an AWS S3 object.");
}

export function skillContentUri(name) {
  assertConfigured();
  return `s3://${config.skills.bucket}/${config.skills.prefix}/${name}.md`;
}

export async function storeSkillContent(
  name,
  content,
  { overwrite = false } = {},
) {
  const uri = skillContentUri(name);
  const { bucket, key } = parseS3Uri(uri, `skill ${name}`);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > config.skills.maxBytes) {
    throw badRequest(
      `Skill content must be at most ${config.skills.maxBytes.toLocaleString()} UTF-8 bytes`,
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
    "store the skill in S3",
  );
  return uri;
}

export async function loadSkillContent(uri, context = "skill") {
  assertConfigured();
  const location = parseS3Uri(uri, context);
  let output;
  try {
    output = await sendRaw(
      new GetObjectCommand({ Bucket: location.bucket, Key: location.key }),
    );
    if (
      Number.isFinite(output.ContentLength) &&
      output.ContentLength > config.skills.maxBytes
    ) {
      throw badGateway("Stored skill exceeds the size limit");
    }
    if (!output.Body) throw badGateway("S3 returned an empty skill body");
    return (await bodyBytes(output.Body, config.skills.maxBytes)).toString("utf8");
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      throw notFound("Skill document was not found in S3");
    }
    throw storageFailure("read the skill from S3", error);
  }
}

export async function deleteManagedSkillContent(uri) {
  if (!config.skills.bucket) return false;
  const location = parseS3Uri(uri, "skill");
  if (!isManagedLocation(location)) return false;
  await send(
    new DeleteObjectCommand({
      Bucket: location.bucket,
      Key: location.key,
    }),
    "delete the skill from S3",
  );
  return true;
}

function isManagedLocation({ bucket, key }) {
  return (
    bucket === config.skills.bucket &&
    key.startsWith(`${config.skills.prefix}/`) &&
    key.endsWith(".md")
  );
}

function assertConfigured() {
  if (!config.skills.bucket) {
    throw badGateway(
      "Skill storage is not configured. Set AGENT_SESSION_S3_BUCKET in agent-console/server/.env.",
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
    config.skills.requestTimeoutMs,
  );
  timer.unref?.();
  try {
    return await clientFor(config.skills.region).send(command, {
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
      throw badGateway("Stored skill exceeds the size limit");
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
        throw badGateway("Stored skill exceeds the size limit");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw badGateway("S3 returned an unsupported skill body");
}

function storageFailure(action, error) {
  return badGateway(`Unable to ${action}`, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

function checked(bucket, key, context) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw badRequest(context + " has an invalid S3 bucket.");
  }
  if (
    !key ||
    key.length > 1_024 ||
    key.includes("..") ||
    !/^[A-Za-z0-9!_.*'()/-]+$/.test(key)
  ) {
    throw badRequest(context + " has an invalid S3 object key.");
  }
  return { bucket, key };
}

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { badGateway, badRequest } from "../lib/http-error.js";

let client;

export async function loadSkillDocument(skill) {
  if (!config.content.s3Region) {
    throw badRequest(
      "Agent references skills, but PLATFORM_CONTENT_S3_REGION is unset.",
    );
  }
  const location = parseS3Uri(skill.uri, "skill " + skill.name);
  const response = await s3Client().send(
    new GetObjectCommand({ Bucket: location.bucket, Key: location.key }),
  );
  if (
    Number.isFinite(response.ContentLength) &&
    response.ContentLength > config.content.maxSkillBytes
  ) {
    throw badGateway(
      "Skill " + skill.name + " exceeds the 2,000,000-byte payload limit.",
    );
  }
  if (!response.Body) {
    throw badGateway("S3 returned an empty response body for skill " + skill.name + ".");
  }
  const bytes =
    typeof response.Body.transformToByteArray === "function"
      ? await response.Body.transformToByteArray()
      : new TextEncoder().encode(await response.Body.transformToString());
  if (bytes.byteLength > config.content.maxSkillBytes) {
    throw badGateway(
      "Skill " + skill.name + " exceeds the 2,000,000-byte payload limit.",
    );
  }
  const document = new TextDecoder().decode(bytes);
  if (!document || document.length > 2_000_000) {
    throw badGateway("Skill " + skill.name + " has an invalid document size.");
  }
  return document;
}

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
  const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
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

function s3Client() {
  if (!client) client = new S3Client({ region: config.content.s3Region });
  return client;
}

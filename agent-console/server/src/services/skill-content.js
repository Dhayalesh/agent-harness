import { badRequest } from "../lib/http-error.js";

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

import { AgentHarnessError } from '../core/errors.js';

/**
 * One object, addressed in full.
 *
 * A skill record carries the whole address rather than a key plus a reference to a
 * bucket record, so there is one field to read and nothing to join against. The region
 * and the credential are not part of it: those come from the environment, and are the
 * same for every object the platform reads.
 */
export type S3Location = {
  bucket: string;
  key: string;
};

/** S3 bucket naming: DNS-label safe, which the virtual-hosted URL form requires. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The characters an object key may hold here. Deliberately narrower than S3 allows. */
const KEY = /^[A-Za-z0-9!_.*'()/-]+$/;

/**
 * What a stored address must look like. Kept loose enough for the schema to use as a
 * cheap shape check, with `parseS3Uri` doing the real validation.
 */
export const S3_URI_PATTERN = /^(s3:\/\/|https:\/\/)[^\s]+$/;

/**
 * Reads a stored address into the bucket and key it names.
 *
 * Both the canonical `s3://bucket/key` and the HTTPS forms the AWS console shows are
 * accepted, because an operator pasting an address will have one or the other and
 * neither is more correct. They normalise to the same pair.
 *
 * A malformed address fails here rather than as a signature rejection or a 404, which
 * are both a long way from the record that caused them.
 */
export function parseS3Uri(uri: string, context: string): S3Location {
  const trimmed = uri.trim();
  const location = fromS3Scheme(trimmed) ?? fromHttps(trimmed);
  if (!location) {
    throw new AgentHarnessError(
      `${context}: '${uri}' is not an S3 address. Expected s3://bucket/key, or the https form ` +
        'the console shows.',
      'S3_URI_INVALID',
    );
  }
  if (!BUCKET.test(location.bucket)) {
    throw new AgentHarnessError(
      `${context}: '${location.bucket}' is not a usable S3 bucket name. It must be 3 to 63 ` +
        'characters of lowercase letters, digits, dots, and hyphens, starting and ending with a ' +
        'letter or digit.',
      'S3_URI_INVALID',
    );
  }
  if (location.key === '' || location.key.length > 1024 || !KEY.test(location.key)) {
    throw new AgentHarnessError(
      `${context}: '${location.key}' is not a usable object key`,
      'S3_URI_INVALID',
    );
  }
  // No bucket record means no prefix bounding what may be addressed, so this is the
  // only structural check left on a key. A `..` segment cannot name an S3 object
  // anyway, and allowing it here would let a key traverse when it reaches the disk.
  if (location.key.includes('..')) {
    throw new AgentHarnessError(
      `${context}: key '${location.key}' contains '..', which cannot address an object`,
      'S3_URI_INVALID',
    );
  }
  return location;
}

/** `s3://bucket/key`, the canonical form, and the one worth storing. */
function fromS3Scheme(uri: string): S3Location | undefined {
  if (!uri.startsWith('s3://')) return undefined;
  const rest = uri.slice('s3://'.length);
  const separator = rest.indexOf('/');
  if (separator <= 0) return undefined;
  return { bucket: rest.slice(0, separator), key: rest.slice(separator + 1) };
}

/**
 * The two HTTPS layouts: virtual-hosted, where the bucket is the first label of the
 * host, and path style, where it is the first path segment.
 */
function fromHttps(uri: string): S3Location | undefined {
  if (!uri.startsWith('https://')) return undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }

  // `<bucket>.s3.<region>.amazonaws.com` or `<bucket>.s3.amazonaws.com`.
  const hosted = url.hostname.match(/^(.+)\.s3[.-][^.]*\.?amazonaws\.com$/);
  if (hosted?.[1]) return { bucket: hosted[1], key };

  // `s3.<region>.amazonaws.com/<bucket>/<key>`.
  if (/^s3[.-][^.]*\.?amazonaws\.com$/.test(url.hostname)) {
    const separator = key.indexOf('/');
    if (separator <= 0) return undefined;
    return { bucket: key.slice(0, separator), key: key.slice(separator + 1) };
  }
  return undefined;
}

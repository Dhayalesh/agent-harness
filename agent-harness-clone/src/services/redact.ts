/**
 * Removes credentials from anything on its way to a log.
 *
 * A payload carries the model credential, the MCP credentials, and arbitrary headers
 * (`src/headless/payload.ts`), and this harness logs payloads and tool arguments in
 * full. That combination puts a bearer token in CloudWatch unless something stands
 * between them, which is what this is.
 *
 * Two passes, because neither alone is enough. `redact` walks structure and blanks
 * values under a key that names a secret — which catches `apiKey` whatever its shape.
 * `scrubText` runs a pattern over strings, for a token that arrives somewhere no key
 * name marks: an `Authorization: Bearer …` line inside a header blob, an `sk-…` a
 * model quoted back in its output.
 */

export const REDACTED = '[redacted]';

/**
 * Matched case-insensitively against the whole key, so `apiKey`, `api_key`, and
 * `ANTHROPIC_API_KEY` all hit. Kept as substrings rather than exact names because the
 * payload's own `headers` maps are caller-defined and cannot be enumerated here.
 */
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'client_secret',
  'cookie',
  'credential',
  'credentials',
  'id_token',
  'password',
  'passwd',
  'private_key',
  'privatekey',
  'refresh_token',
  'service_key',
  'session_key',
  'session_token',
  'signature',
  'token',
]);

// Token usage is telemetry, not a credential.
const SAFE_MEASUREMENT_KEYS = new Set([
  'cache_read_tokens',
  'cache_write_tokens',
  'input_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'output_tokens',
  'token_count',
  'tokens_after',
  'tokens_before',
]);

/**
 * `auth` in this payload is sometimes a harmless discriminator (`{ kind: 'bearer' }`)
 * rather than the secret itself, so a key named exactly this is descended into and
 * judged by its own leaves instead of being blanked whole. Its `token`/`apiKey` child
 * still matches the list above.
 */
const STRUCTURAL_KEYS = new Set(['auth', 'authentication']);

function isSecretKey(key: string): boolean {
  const lowered = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
  if (STRUCTURAL_KEYS.has(lowered) || SAFE_MEASUREMENT_KEYS.has(lowered)) return false;
  if (SECRET_KEYS.has(lowered)) return true;
  return /(^|_)(api_?key|secret|password|passwd|private_?key|service_?key|credential|access_?key|client_?secret|refresh_?token|session_?token|id_?token|authorization|cookie|signature|token)($|_)/.test(
    lowered,
  );
}

/** Long, high-entropy, or explicitly prefixed strings that read as credentials. */
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /\bsk-[A-Za-z0-9._\-]{12,}/g,
  /\bsk-ant-[A-Za-z0-9._\-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bASIA[0-9A-Z]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z._\-]{20,}/g,
  /\beyJ[A-Za-z0-9._\-]{20,}/g, // JWT
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
];

export function scrubText(value: string): string {
  let result = scrubUrl(value);
  for (const pattern of SECRET_TEXT_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

function scrubUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const name of [...url.searchParams.keys()]) {
      if (isSecretKey(name)) url.searchParams.set(name, REDACTED);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export type RedactOptions = {
  /**
   * Longest string kept whole. Longer ones are cut with a marker naming the bytes
   * dropped, so a reader can tell truncation from a genuinely short value. Unset
   * keeps everything, which is the default for payload and tool logging.
   */
  maxStringLength?: number;
  /** Guards against a cyclic or pathologically deep object. */
  maxDepth?: number;
};

/**
 * A structural copy with secrets removed, safe to `JSON.stringify`.
 *
 * Never throws and never returns the input by reference: a caller is logging, and a
 * redactor that threw on a cycle would take the run's observability down with it.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 12;
  return walk(value, options, maxDepth, new WeakSet<object>());
}

function walk(
  value: unknown,
  options: RedactOptions,
  depthLeft: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return truncate(scrubText(value), options.maxStringLength);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: truncate(scrubText(value.message), 2000) };
  }
  // A buffer's bytes are never useful in a log and may be a key file.
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;

  if (typeof value !== 'object') return String(value);
  if (depthLeft <= 0) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry, options, depthLeft - 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSecretKey(key) ? REDACTED : walk(entry, options, depthLeft - 1, seen);
    }
    return result;
  } finally {
    // Released so a value legitimately repeated across sibling branches is not
    // reported as circular.
    seen.delete(value);
  }
}

function truncate(value: string, maximum: number | undefined): string {
  if (maximum === undefined || value.length <= maximum) return value;
  return `${value.slice(0, maximum)}…[+${value.length - maximum} chars]`;
}

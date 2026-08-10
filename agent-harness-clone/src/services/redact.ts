/**
 * Removes credentials from anything on its way to a log.
 *
 * A payload carries the model credential, the MCP credentials, and arbitrary headers
 * (`src/headless/payload.ts`), and DEBUG logs may include payloads and tool arguments.
 * That combination puts a bearer token in CloudWatch unless something stands between
 * them, which is what this is.
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
  'access_key',
  'apikey',
  'api_key',
  'auth',
  'authentication',
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
  'secret',
  'service_key',
  'sig',
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
const SECRET_CONTAINER_KEYS = new Set([
  'default_headers',
  'env',
  'environment',
  'headers',
  'request_headers',
]);
const SAFE_HEADER_KEYS = new Set([
  'accept',
  'accept_encoding',
  'cache_control',
  'content_length',
  'content_type',
  'host',
  'user_agent',
  'x_amzn_bedrock_agentcore_runtime_session_id',
  'x_amzn_trace_id',
]);

function isSecretKey(key: string): boolean {
  const lowered = normalizeKey(key);
  if (STRUCTURAL_KEYS.has(lowered) || SAFE_MEASUREMENT_KEYS.has(lowered)) return false;
  if (SECRET_KEYS.has(lowered)) return true;
  return /(^|_)(api_?key|secret|password|passwd|private_?key|service_?key|credential|access_?key|client_?secret|refresh_?token|session_?token|id_?token|authorization|cookie|signature|token|sig|oauth_?code)($|_)/.test(
    lowered,
  );
}

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();
}

/** Long, high-entropy, or explicitly prefixed strings that read as credentials. */
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:Authorization|Proxy-Authorization|X-Api-Key|Api-Key)\s*[:=]\s*[^\s,;]+/gi,
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
  let result = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s\x22\x27<>]+/gi, (candidate) =>
    scrubUrl(candidate),
  );
  for (const pattern of SECRET_TEXT_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

function scrubUrl(value: string): string {
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
   * keeps everything, which is used for redacted DEBUG payload and tool records.
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

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString();
  }
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
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      return '[unreadable object]';
    }
    for (const key of keys) {
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        result[key] = '[unreadable]';
        continue;
      }
      const normalized = normalizeKey(key);
      if (SECRET_CONTAINER_KEYS.has(normalized)) {
        result[key] = redactSecretContainer(entry, normalized, options, depthLeft - 1, seen);
      } else if (normalized === 'args' && Array.isArray(entry)) {
        result[key] = redactArguments(entry, options, depthLeft - 1, seen);
      } else if (STRUCTURAL_KEYS.has(normalized)) {
        result[key] =
          entry !== null && typeof entry === 'object'
            ? walk(entry, options, depthLeft - 1, seen)
            : REDACTED;
      } else {
        result[key] = isSecretKey(key) ? REDACTED : walk(entry, options, depthLeft - 1, seen);
      }
    }
    return result;
  } finally {
    // Released so a value legitimately repeated across sibling branches is not
    // reported as circular.
    seen.delete(value);
  }
}

function redactSecretContainer(
  value: unknown,
  container: string,
  options: RedactOptions,
  depthLeft: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return '[unreadable object]';
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (container.includes('header') && SAFE_HEADER_KEYS.has(normalizeKey(key))) {
      try {
        result[key] = walk((value as Record<string, unknown>)[key], options, depthLeft, seen);
      } catch {
        result[key] = '[unreadable]';
      }
    } else {
      result[key] = REDACTED;
    }
  }
  return result;
}

function redactArguments(
  args: unknown[],
  options: RedactOptions,
  depthLeft: number,
  seen: WeakSet<object>,
): unknown[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED;
    }
    if (typeof argument !== 'string') return walk(argument, options, depthLeft, seen);
    if (/^-H$/.test(argument) || /^--(?:header|env)$/i.test(argument)) {
      redactNext = true;
      return argument;
    }
    const assignment = argument.match(
      /^(--?[^=]*(?:api[-_]?key|auth|authorization|cookie|credential|env|header|password|secret|signature|token))=(.*)$/i,
    );
    if (assignment) return String(assignment[1]) + '=' + REDACTED;
    if (
      /^--?[^=]*(?:api[-_]?key|auth|authorization|cookie|credential|env|header|password|secret|signature|token)$/i.test(
        argument,
      )
    ) {
      redactNext = true;
      return argument;
    }
    return truncate(scrubText(argument), options.maxStringLength);
  });
}

function truncate(value: string, maximum: number | undefined): string {
  if (maximum === undefined || value.length <= maximum) return value;
  return `${value.slice(0, maximum)}…[+${value.length - maximum} chars]`;
}

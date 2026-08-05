import { createHash, createHmac } from 'node:crypto';
import { AgentHarnessError } from '../../src/core/errors.js';
import type {
  ContentLocation,
  ContentStore,
  LoadedContent,
} from '../../src/content/content-store.js';
import { assertMatches, locate } from '../../src/content/content-store.js';

/** Hex sha256 of an empty body, which is what a GET and a DELETE sign. */
const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary credentials, which also sign a token header. */
  sessionToken?: string | undefined;
};

export type S3ContentStoreOptions = {
  bucket: string;
  region: string;
  /**
   * Only for an S3-compatible endpoint such as MinIO. Absent targets AWS at
   * `https://<bucket>.s3.<region>.amazonaws.com`.
   */
  endpoint?: string | undefined;
  credentials: S3Credentials;
  /**
   * Puts the bucket in the path instead of the host. Required by most
   * S3-compatible servers, and by any bucket whose name is not a valid DNS label.
   */
  forcePathStyle?: boolean | undefined;
  requestTimeoutMs: number;
  /** Bodies above this are refused before being read. */
  maxObjectBytes: number;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImplementation?: typeof fetch | undefined;
  clock?: (() => Date) | undefined;
};

/**
 * Reads agent content from S3, or from anything speaking its GET/PUT object API.
 *
 * Requests are signed here with `node:crypto` rather than through an AWS SDK. The
 * credential is passed in explicitly, from `PLATFORM_CONTENT_S3_REGION` and the
 * `AWS_*` pair, so the only thing an SDK would add is its credential-resolution
 * chain ÔÇö which would let an instance profile or a shared config file stand in for
 * the key that was configured, and make what a run reads depend on where it happens
 * to be running.
 */
export class S3ContentStore implements ContentStore {
  readonly description: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly clock: () => Date;

  constructor(private readonly options: S3ContentStoreOptions) {
    this.description = `s3://${options.bucket}${options.endpoint ? ` at ${options.endpoint}` : ''}`;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async read(location: ContentLocation): Promise<string> {
    if (location.bytes > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Content reference ${location.key} records ${location.bytes} bytes, above the ` +
          `${this.options.maxObjectBytes} this bucket allows.`,
        'CONTENT_TOO_LARGE',
      );
    }
    const response = await this.send('GET', location.key);
    if (response.status === 404) {
      throw new AgentHarnessError(
        `No object at ${this.target(location.key)}. Upload it, or point the record at an ` +
          'object that exists with node scripts/skill/editSkill.js.',
        'CONTENT_NOT_FOUND',
      );
    }
    if (!response.ok) throw await requestFailed(response, 'read', this.target(location.key));
    // The declared length is checked before the body is read, so an object that
    // grew past the reference cannot be buffered in full first.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Object at ${this.target(location.key)} is ${declared} bytes, above the ` +
          `${this.options.maxObjectBytes} this bucket allows.`,
        'CONTENT_TOO_LARGE',
      );
    }
    return assertMatches(location, await response.text(), this.target(location.key));
  }

  async write(key: string, text: string): Promise<ContentLocation> {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Content is ${bytes} bytes, above the ${this.options.maxObjectBytes} this bucket allows.`,
        'CONTENT_TOO_LARGE',
      );
    }
    const response = await this.send('PUT', key, text);
    if (!response.ok) throw await requestFailed(response, 'write', this.target(key));
    return locate(key, text);
  }

  async load(key: string): Promise<LoadedContent> {
    const response = await this.send('GET', key);
    if (response.status === 404) {
      throw new AgentHarnessError(
        `No object at ${this.target(key)}. Upload it, or point the record at an object that ` +
          'exists with node scripts/skill/editSkill.js.',
        'CONTENT_NOT_FOUND',
      );
    }
    if (!response.ok) throw await requestFailed(response, 'read', this.target(key));
    // Checked before the body is read, so an oversized object is refused rather
    // than buffered in full to find out how big it is.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Object at ${this.target(key)} is ${declared} bytes, above the ` +
          `${this.options.maxObjectBytes} this bucket allows.`,
        'CONTENT_TOO_LARGE',
      );
    }
    const text = await response.text();
    const location = locate(key, text);
    // Checked again from the bytes that arrived: `content-length` may have been
    // absent, and a chunked response can carry more than it declared.
    if (location.bytes > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Object at ${this.target(key)} is ${location.bytes} bytes, above the ` +
          `${this.options.maxObjectBytes} this bucket allows.`,
        'CONTENT_TOO_LARGE',
      );
    }
    return { location, text };
  }

  async describe(key: string): Promise<ContentLocation> {
    return (await this.load(key)).location;
  }

  private target(key: string): string {
    return `${this.description}/${key}`;
  }

  private async send(method: 'GET' | 'PUT', key: string, body?: string): Promise<Response> {
    const url = this.url(key);
    const payloadHash =
      body === undefined
        ? EMPTY_PAYLOAD_SHA256
        : createHash('sha256').update(body, 'utf8').digest('hex');
    const headers = signS3Request({
      method,
      url,
      payloadHash,
      region: this.options.region,
      credentials: this.options.credentials,
      now: this.clock(),
      ...(body === undefined ? {} : { contentType: 'text/markdown; charset=utf-8' }),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      return await this.fetchImplementation(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new AgentHarnessError(
        `Content ${method === 'GET' ? 'read' : 'write'} failed for ${this.target(key)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        controller.signal.aborted ? 'CONTENT_TIMEOUT' : 'CONTENT_REQUEST_FAILED',
        true,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Path style puts the bucket in the path, which every S3-compatible server
   * accepts; AWS otherwise gets the virtual-hosted form it prefers.
   */
  private url(key: string): string {
    const encodedKey = encodeS3Key(key);
    if (this.options.endpoint) {
      const base = new URL(this.options.endpoint);
      const prefix = base.pathname.replace(/\/$/, '');
      const path =
        this.options.forcePathStyle === false
          ? `${prefix}/${encodedKey}`
          : `${prefix}/${this.options.bucket}/${encodedKey}`;
      return new URL(path, base).toString();
    }
    return this.options.forcePathStyle
      ? `https://s3.${this.options.region}.amazonaws.com/${this.options.bucket}/${encodedKey}`
      : `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${encodedKey}`;
  }
}

export type SignS3RequestInput = {
  method: string;
  url: string;
  payloadHash: string;
  region: string;
  credentials: S3Credentials;
  now: Date;
  contentType?: string | undefined;
};

/**
 * Builds the SigV4 headers for one S3 request.
 *
 * Exported so the signing can be asserted directly: a signature is only ever
 * observed as a 403 otherwise, which makes a mistake here expensive to find.
 */
export function signS3Request(input: SignS3RequestInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = `${input.now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate,
    ...(input.credentials.sessionToken
      ? { 'x-amz-security-token': input.credentials.sessionToken }
      : {}),
    ...(input.contentType ? { 'content-type': input.contentType } : {}),
  };
  // Signed headers are sorted by lowercase name, which is also the order their
  // canonical form has to appear in.
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]?.trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    input.method,
    // Already encoded by the caller; S3 signs the path as it appears on the wire.
    url.pathname,
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const signature = hmac(
    signingKey(input.credentials.secretAccessKey, dateStamp, input.region),
    stringToSign,
  ).toString('hex');

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** `kSecret -> kDate -> kRegion -> kService -> kSigning`, as SigV4 specifies. */
function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const date = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  const scopedRegion = hmac(date, region);
  const service = hmac(scopedRegion, SERVICE);
  return hmac(service, 'aws4_request');
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function canonicalQuery(url: URL): string {
  const parameters = [...url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return parameters.map(([name, value]) => `${name}=${value}`).join('&');
}

/**
 * A key is encoded segment by segment: `/` separates segments and must stay
 * literal, while everything else follows RFC 3986 so the signed path matches the
 * path sent.
 */
export function encodeS3Key(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

/** `encodeURIComponent` leaves these six unescaped; RFC 3986 does not. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function requestFailed(
  response: Response,
  operation: 'read' | 'write',
  target: string,
): Promise<AgentHarnessError> {
  // S3 returns XML on failure. It is included verbatim and bounded, because the
  // Code element is usually the whole diagnosis.
  const detail = (await response.text().catch(() => '')).slice(0, 500);
  return new AgentHarnessError(
    `Content ${operation} failed for ${target}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
    'CONTENT_REQUEST_FAILED',
    response.status >= 500 || response.status === 429,
  );
}

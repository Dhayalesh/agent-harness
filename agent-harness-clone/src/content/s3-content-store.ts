import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectOutput,
} from '@aws-sdk/client-s3';
import { AgentHarnessError } from '../core/errors.js';
import type { ContentLocation, ContentStore, LoadedContent } from './content-store.js';
import { assertMatches, locate } from './content-store.js';

export type S3ContentStoreOptions = {
  bucket: string;
  /**
   * Falls back to the SDK's normal region resolution when omitted. In AgentCore that
   * is the region already attached to the runtime; locally it may come from
   * `AWS_REGION` or the shared AWS config.
   */
  region?: string;
  /** Only for an S3-compatible service such as MinIO. */
  endpoint?: string;
  /** Required by most S3-compatible services. AWS itself prefers virtual hosting. */
  forcePathStyle?: boolean;
  /** Injected in tests, or when a host already owns an S3 client. */
  client?: S3Client;
  requestTimeoutMs: number;
  /** Bodies above this are stopped and refused while they are being read. */
  maxObjectBytes: number;
};

/**
 * Reads and writes agent content in one S3 bucket.
 *
 * Authentication is intentionally not part of the payload. The SDK uses the host's
 * standard credential chain, so a deployed runtime can use its execution role and a
 * local process can use the usual AWS environment or profile. A caller can therefore
 * choose an object only within the buckets and prefixes that role is allowed to read.
 */
export class S3ContentStore implements ContentStore {
  readonly description: string;
  private readonly client: S3Client;
  private readonly ownsClient: boolean;

  constructor(private readonly options: S3ContentStoreOptions) {
    this.description = `s3://${options.bucket}${options.endpoint ? ` at ${options.endpoint}` : ''}`;
    this.ownsClient = options.client === undefined;
    this.client =
      options.client ??
      new S3Client({
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      });
  }

  async read(location: ContentLocation): Promise<string> {
    this.assertReferenceSize(location);
    return assertMatches(location, await this.readObject(location.key), this.target(location.key));
  }

  async write(key: string, text: string): Promise<ContentLocation> {
    const location = locate(key, text);
    if (location.bytes > this.options.maxObjectBytes) {
      throw new AgentHarnessError(
        `Content is ${location.bytes} bytes, above the ${this.options.maxObjectBytes} this ` +
          'bucket allows.',
        'CONTENT_TOO_LARGE',
      );
    }

    await this.request(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: text,
        ContentLength: location.bytes,
        ContentType: 'text/markdown; charset=utf-8',
      }),
      'write',
      key,
      async () => undefined,
    );
    return location;
  }

  async load(key: string): Promise<LoadedContent> {
    const text = await this.readObject(key);
    return { location: locate(key, text), text };
  }

  async describe(key: string): Promise<ContentLocation> {
    return (await this.load(key)).location;
  }

  /** Releases the SDK client's sockets when this store created the client itself. */
  destroy(): void {
    if (this.ownsClient) this.client.destroy();
  }

  private async readObject(key: string): Promise<string> {
    return this.request(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      'read',
      key,
      async (output, signal) => {
        const response = output as GetObjectOutput;
        if (
          response.ContentLength !== undefined &&
          response.ContentLength > this.options.maxObjectBytes
        ) {
          cancelBody(response.Body);
          throw this.tooLarge(key, response.ContentLength);
        }
        if (!response.Body) {
          throw new AgentHarnessError(
            `S3 returned no body for ${this.target(key)}`,
            'CONTENT_REQUEST_FAILED',
            true,
          );
        }
        return readUtf8(response.Body, this.options.maxObjectBytes, signal, () =>
          this.tooLarge(key),
        );
      },
    );
  }

  private async request<T>(
    command: GetObjectCommand | PutObjectCommand,
    operation: 'read' | 'write',
    key: string,
    consume: (output: unknown, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    timer.unref?.();
    try {
      const output: unknown = await this.client.send(command as never, {
        abortSignal: controller.signal,
      });
      return await consume(output, controller.signal);
    } catch (error) {
      if (error instanceof AgentHarnessError) throw error;
      if (isNotFound(error)) {
        throw new AgentHarnessError(
          `No object at ${this.target(key)}`,
          'CONTENT_NOT_FOUND',
          false,
          { cause: error },
        );
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new AgentHarnessError(
        `Content ${operation} failed for ${this.target(key)}: ${detail}`,
        controller.signal.aborted ? 'CONTENT_TIMEOUT' : 'CONTENT_REQUEST_FAILED',
        isRecoverable(error) || controller.signal.aborted,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private assertReferenceSize(location: ContentLocation): void {
    if (location.bytes <= this.options.maxObjectBytes) return;
    throw new AgentHarnessError(
      `Content reference ${location.key} records ${location.bytes} bytes, above the ` +
        `${this.options.maxObjectBytes} this bucket allows.`,
      'CONTENT_TOO_LARGE',
    );
  }

  private tooLarge(key: string, bytes?: number): AgentHarnessError {
    return new AgentHarnessError(
      `Object at ${this.target(key)}${bytes === undefined ? '' : ` is ${bytes} bytes,`} ` +
        `exceeds the ${this.options.maxObjectBytes}-byte limit.`,
      'CONTENT_TOO_LARGE',
    );
  }

  private target(key: string): string {
    return `s3://${this.options.bucket}/${key}`;
  }
}

/**
 * Reads a streaming SDK body with a hard cutoff rather than buffering an unbounded
 * chunked response and checking its size afterwards.
 */
async function readUtf8(
  body: NonNullable<GetObjectOutput['Body']>,
  maximumBytes: number,
  signal: AbortSignal,
  tooLarge: () => AgentHarnessError,
): Promise<string> {
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await withAbort(iterator.next(), signal);
        if (next.done) break;
        const chunk = next.value;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maximumBytes) throw tooLarge();
        chunks.push(buffer);
      }
    } catch (error) {
      cancelBody(body, iterator);
      throw error;
    }
    return decodeUtf8(Buffer.concat(chunks, bytes));
  }

  if (!hasByteArrayTransform(body)) {
    throw new AgentHarnessError(
      'S3 returned an unsupported response body',
      'CONTENT_REQUEST_FAILED',
    );
  }
  try {
    const bytes = await withAbort(body.transformToByteArray(), signal);
    if (bytes.byteLength > maximumBytes) throw tooLarge();
    return decodeUtf8(bytes);
  } catch (error) {
    cancelBody(body);
    throw error;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AgentHarnessError(
      'S3 content is not valid UTF-8 text',
      'CONTENT_INVALID_ENCODING',
      false,
      { cause: error },
    );
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

function hasByteArrayTransform(
  value: unknown,
): value is { transformToByteArray(): Promise<Uint8Array> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'transformToByteArray' in value &&
    typeof value.transformToByteArray === 'function'
  );
}

function cancelBody(value: unknown, iterator?: AsyncIterator<Uint8Array | string>): void {
  void iterator?.return?.().catch(() => undefined);
  if (
    typeof value === 'object' &&
    value !== null &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  ) {
    value.destroy();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'cancel' in value &&
    typeof value.cancel === 'function'
  ) {
    void Promise.resolve(value.cancel()).catch(() => undefined);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error('S3 response timed out');
  error.name = 'AbortError';
  return error;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    value.$metadata?.httpStatusCode === 404 ||
    value.name === 'NoSuchKey' ||
    value.name === 'NotFound'
  );
}

function isRecoverable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = value.$metadata?.httpStatusCode;
  return (
    value.$retryable !== undefined || status === 429 || (status !== undefined && status >= 500)
  );
}

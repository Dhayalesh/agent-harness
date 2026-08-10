import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectOutput,
  type ListObjectsV2Output,
} from '@aws-sdk/client-s3';
import { AgentHarnessError } from '../core/errors.js';
import {
  assertSessionSize,
  type SessionStore,
  type StoredSession,
  validateStoredSession,
} from './session-store.js';

export type S3SessionStoreOptions = {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
  maxBytes?: number;
  client?: S3Client;
};

type S3Command = DeleteObjectCommand | GetObjectCommand | ListObjectsV2Command | PutObjectCommand;

/** Durable session storage with optimistic concurrency through S3 ETags. */
export class S3SessionStore implements SessionStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly prefix: string;
  private readonly etags = new Map<string, string>();
  private readonly observed = new Set<string>();
  private readonly present = new Set<string>();

  constructor(private readonly options: S3SessionStoreOptions) {
    if (!options.bucket.trim()) {
      throw new AgentHarnessError('S3 session bucket is required', 'SESSION_S3_BUCKET_REQUIRED');
    }
    this.prefix = normalizePrefix(options.prefix);
    this.ownsClient = options.client === undefined;
    this.client =
      options.client ??
      new S3Client({
        ...(options.region ? { region: options.region } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      });
  }

  async load(id: string): Promise<StoredSession | undefined> {
    const key = this.keyFor(id);
    try {
      const output = (await this.request(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        }),
      )) as GetObjectOutput;
      const text = await readBody(output, this.options.maxBytes ?? 10 * 1024 * 1024);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        throw new AgentHarnessError(
          `S3 session object ${key} is not valid JSON`,
          'INVALID_STORED_SESSION',
          false,
          { cause: error },
        );
      }
      const session = validateStoredSession(parsed);
      if (session.id !== id) {
        throw new AgentHarnessError(
          `S3 session object ${key} contains a different session ID`,
          'INVALID_STORED_SESSION',
        );
      }
      this.observed.add(id);
      this.present.add(id);
      if (output.ETag) this.etags.set(id, output.ETag);
      return session;
    } catch (error) {
      if (isNotFound(error)) {
        this.observed.add(id);
        this.etags.delete(id);
        this.present.delete(id);
        return undefined;
      }
      throw this.translate(error, 'load', key);
    }
  }

  async save(session: StoredSession): Promise<void> {
    assertSessionId(session.id);
    assertSessionSize(session, this.options.maxBytes);
    const key = this.keyFor(session.id);
    const body = JSON.stringify(session);
    const etag = this.etags.get(session.id);
    try {
      const output = (await this.request(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentLength: Buffer.byteLength(body, 'utf8'),
          ContentType: 'application/json; charset=utf-8',
          ServerSideEncryption: 'AES256',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      )) as { ETag?: string };
      this.observed.add(session.id);
      this.present.add(session.id);
      if (output.ETag) {
        this.etags.set(session.id, output.ETag);
      } else {
        // A conforming S3 response includes an ETag. Re-read defensively rather
        // than allowing the next save to become an unconditional overwrite.
        this.etags.delete(session.id);
        if (!(await this.load(session.id))) {
          throw new AgentHarnessError(
            `S3 acknowledged session ${session.id} but it could not be read back`,
            'SESSION_S3_REQUEST_FAILED',
            true,
          );
        }
      }
    } catch (error) {
      if (isConflict(error)) {
        throw new AgentHarnessError(
          `Session ${session.id} changed in S3 while this invocation was running`,
          'SESSION_CONFLICT',
          true,
          { cause: error },
        );
      }
      throw this.translate(error, 'save', key);
    }
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.observed.has(id)
      ? this.present.has(id)
      : (await this.load(id)) !== undefined;
    if (!existing) return false;
    const key = this.keyFor(id);
    try {
      await this.request(
        new DeleteObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
        }),
      );
      this.observed.add(id);
      this.etags.delete(id);
      this.present.delete(id);
      return true;
    } catch (error) {
      throw this.translate(error, 'delete', key);
    }
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    const ids: string[] = [];
    let continuationToken: string | undefined;
    do {
      let output: ListObjectsV2Output;
      try {
        output = (await this.request(
          new ListObjectsV2Command({
            Bucket: this.options.bucket,
            Prefix: this.objectPrefix(),
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        )) as ListObjectsV2Output;
      } catch (error) {
        throw this.translate(error, 'list', this.objectPrefix());
      }
      for (const object of output.Contents ?? []) {
        const id = object.Key && this.idFromKey(object.Key);
        if (id) ids.push(id);
      }
      continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (continuationToken);

    const sessions = await Promise.all(ids.map((id) => this.load(id)));
    return sessions
      .filter((session): session is StoredSession => session !== undefined)
      .map(({ id, createdAt, updatedAt, metadata }) => ({
        id,
        createdAt,
        updatedAt,
        metadata,
      }));
  }

  destroy(): void {
    if (this.ownsClient) this.client.destroy();
  }

  private async request(command: S3Command): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    timer.unref?.();
    try {
      return await this.client.send(command as never, { abortSignal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private translate(error: unknown, operation: string, key: string): AgentHarnessError {
    if (error instanceof AgentHarnessError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new AgentHarnessError(
      `S3 session ${operation} failed for s3://${this.options.bucket}/${key}: ${detail}`,
      isAbort(error) ? 'SESSION_S3_TIMEOUT' : 'SESSION_S3_REQUEST_FAILED',
      isAbort(error) || isRecoverable(error),
      { cause: error },
    );
  }

  private keyFor(id: string): string {
    assertSessionId(id);
    return `${this.objectPrefix()}${id}.json`;
  }

  private objectPrefix(): string {
    return this.prefix ? `${this.prefix}/` : '';
  }

  private idFromKey(key: string): string | undefined {
    const prefix = this.objectPrefix();
    if (!key.startsWith(prefix) || !key.endsWith('.json')) return undefined;
    const id = key.slice(prefix.length, -5);
    return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
  }
}

async function readBody(output: GetObjectOutput, maximum: number): Promise<string> {
  if (output.ContentLength !== undefined && output.ContentLength > maximum) {
    throw new AgentHarnessError(
      `Stored S3 session is ${output.ContentLength} bytes; maximum is ${maximum}`,
      'SESSION_TOO_LARGE',
    );
  }
  if (!output.Body) {
    throw new AgentHarnessError(
      'S3 returned an unsupported session body',
      'INVALID_STORED_SESSION',
    );
  }
  const bytes = await bodyBytes(output.Body, maximum);
  if (bytes.byteLength > maximum) {
    throw new AgentHarnessError(
      `Stored S3 session is ${bytes.byteLength} bytes; maximum is ${maximum}`,
      'SESSION_TOO_LARGE',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AgentHarnessError(
      'Stored S3 session is not valid UTF-8',
      'INVALID_STORED_SESSION',
      false,
      { cause: error },
    );
  }
}

async function bodyBytes(body: unknown, maximum: number): Promise<Uint8Array> {
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    return body.transformToByteArray() as Promise<Uint8Array>;
  }
  if (
    typeof body === 'object' &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === 'function'
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maximum) {
        throw new AgentHarnessError(
          `Stored S3 session exceeds the ${maximum}-byte limit`,
          'SESSION_TOO_LARGE',
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }
  throw new AgentHarnessError('S3 returned an unsupported session body', 'INVALID_STORED_SESSION');
}

function normalizePrefix(value = 'sessions'): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AgentHarnessError('Invalid session ID', 'INVALID_SESSION_ID');
  }
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.$metadata?.httpStatusCode === 404 || value?.name === 'NoSuchKey';
}

function isConflict(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 409 || status === 412;
}

function isRecoverable(error: unknown): boolean {
  const value = error as { $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = value?.$metadata?.httpStatusCode;
  return (
    value?.$retryable !== undefined || status === 429 || (status !== undefined && status >= 500)
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

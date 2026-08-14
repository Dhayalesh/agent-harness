import { createHash, randomUUID } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectOutput,
  type HeadObjectOutput,
  type PutObjectOutput,
} from '@aws-sdk/client-s3';
import { AgentHarnessError } from '../core/errors.js';
import type { Artifact, ArtifactStore } from './artifact-store.js';

export type S3ArtifactStoreOptions = {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  requestTimeoutMs?: number;
  maxBytes?: number;
  client?: S3Client;
};

type S3Command = GetObjectCommand | HeadObjectCommand | PutObjectCommand;

/** Private, immutable storage for response artifacts. */
export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(private readonly options: S3ArtifactStoreOptions) {
    if (!options.bucket.trim()) {
      throw new AgentHarnessError('S3 artifact bucket is required', 'ARTIFACT_S3_BUCKET_REQUIRED');
    }
    this.prefix = normalizePrefix(options.prefix);
    this.client =
      options.client ??
      new S3Client({
        ...(options.region ? { region: options.region } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      });
  }

  async put(
    content: string | Uint8Array,
    options: { contentType?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<Artifact> {
    const id = randomUUID();
    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const maximum = this.options.maxBytes ?? 2_000_000;
    if (body.byteLength > maximum) {
      throw new AgentHarnessError(
        `Artifact is ${body.byteLength} bytes; maximum is ${maximum}`,
        'ARTIFACT_TOO_LARGE',
      );
    }
    const createdAt = new Date().toISOString();
    const contentType = options.contentType ?? 'text/plain';
    const key = this.keyFor(id, contentType);
    const checksumSha256 = createHash('sha256').update(body).digest('base64');
    const metadata = structuredClone(options.metadata ?? {});
    try {
      const output = (await this.request(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ContentType: contentType,
          ChecksumSHA256: checksumSha256,
          IfNoneMatch: '*',
          ServerSideEncryption: 'AES256',
          Metadata: objectMetadata(id, createdAt, metadata),
        }),
      )) as PutObjectOutput;
      return {
        id,
        contentType,
        size: body.byteLength,
        createdAt,
        metadata,
        storage: {
          kind: 's3',
          bucket: this.options.bucket,
          key,
          ...(this.options.region ? { region: this.options.region } : {}),
          ...(output.VersionId ? { versionId: output.VersionId } : {}),
          ...(output.ETag ? { etag: output.ETag } : {}),
          checksumSha256: output.ChecksumSHA256 ?? checksumSha256,
        },
      };
    } catch (error) {
      throw this.translate(error, 'write', key);
    }
  }

  async get(id: string): Promise<Uint8Array | undefined> {
    const key = this.keyForId(id);
    try {
      const output = (await this.request(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      )) as GetObjectOutput;
      if (!output.Body) {
        throw new AgentHarnessError('S3 returned an empty artifact body', 'INVALID_ARTIFACT');
      }
      const maximum = this.options.maxBytes ?? 2_000_000;
      if (output.ContentLength !== undefined && output.ContentLength > maximum) {
        throw new AgentHarnessError(
          `Stored artifact is ${output.ContentLength} bytes; maximum is ${maximum}`,
          'ARTIFACT_TOO_LARGE',
        );
      }
      const bytes = await bodyBytes(output.Body);
      if (bytes.byteLength > maximum) {
        throw new AgentHarnessError(
          `Stored artifact is ${bytes.byteLength} bytes; maximum is ${maximum}`,
          'ARTIFACT_TOO_LARGE',
        );
      }
      return bytes;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw this.translate(error, 'read', key);
    }
  }

  async describe(id: string): Promise<Artifact | undefined> {
    const key = this.keyForId(id);
    try {
      const output = (await this.request(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      )) as HeadObjectOutput;
      const metadata = decodeMetadata(output.Metadata?.descriptor);
      return {
        id,
        contentType: output.ContentType ?? 'text/markdown; charset=utf-8',
        size: output.ContentLength ?? 0,
        createdAt: output.Metadata?.['created-at'] ?? output.LastModified?.toISOString() ?? '',
        metadata,
        storage: {
          kind: 's3',
          bucket: this.options.bucket,
          key,
          ...(this.options.region ? { region: this.options.region } : {}),
          ...(output.VersionId ? { versionId: output.VersionId } : {}),
          ...(output.ETag ? { etag: output.ETag } : {}),
          ...(output.ChecksumSHA256 ? { checksumSha256: output.ChecksumSHA256 } : {}),
        },
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw this.translate(error, 'describe', key);
    }
  }

  private keyFor(id: string, contentType: string): string {
    return `${this.objectPrefix()}${id}${contentType.startsWith('text/markdown') ? '.md' : '.data'}`;
  }

  private keyForId(id: string): string {
    assertArtifactId(id);
    // S3ArtifactStore is currently used only by create_markdown_artifact.
    return `${this.objectPrefix()}${id}.md`;
  }

  private objectPrefix(): string {
    return this.prefix ? `${this.prefix}/` : '';
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
      `S3 artifact ${operation} failed for s3://${this.options.bucket}/${key}: ${detail}`,
      isAbort(error) ? 'ARTIFACT_S3_TIMEOUT' : 'ARTIFACT_S3_REQUEST_FAILED',
      isAbort(error) || isRecoverable(error),
      { cause: error },
    );
  }
}

function objectMetadata(id: string, createdAt: string, metadata: Record<string, unknown>) {
  return {
    'artifact-id': id,
    'created-at': createdAt,
    descriptor: Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url'),
  };
}

function decodeMetadata(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
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
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new AgentHarnessError('S3 returned an unsupported artifact body', 'INVALID_ARTIFACT');
}

function normalizePrefix(value = 'artifacts'): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

function assertArtifactId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AgentHarnessError('Invalid artifact ID', 'INVALID_ARTIFACT_ID');
  }
}

function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.$metadata?.httpStatusCode === 404 || value?.name === 'NoSuchKey';
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

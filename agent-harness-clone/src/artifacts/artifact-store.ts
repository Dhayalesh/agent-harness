import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentHarnessError } from '../core/errors.js';

export type Artifact = {
  id: string;
  contentType: string;
  size: number;
  createdAt: string;
  metadata: Record<string, unknown>;
  /** Durable object location. Contents are deliberately not embedded in events. */
  storage?: {
    kind: 's3';
    bucket: string;
    key: string;
    region?: string;
    versionId?: string;
    etag?: string;
    checksumSha256?: string;
  };
};

export interface ArtifactStore {
  put(
    content: string | Uint8Array,
    options?: { contentType?: string; metadata?: Record<string, unknown> },
  ): Promise<Artifact>;
  get(id: string): Promise<string | Uint8Array | undefined>;
  describe(id: string): Promise<Artifact | undefined>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, string | Uint8Array>();
  private readonly descriptions = new Map<string, Artifact>();

  async put(
    content: string | Uint8Array,
    options: { contentType?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<Artifact> {
    const id = randomUUID();
    this.artifacts.set(id, typeof content === 'string' ? content : new Uint8Array(content));
    const artifact = describe(id, content, options);
    this.descriptions.set(id, artifact);
    return artifact;
  }

  async get(id: string): Promise<string | Uint8Array | undefined> {
    const value = this.artifacts.get(id);
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : new Uint8Array(value);
  }

  async describe(id: string): Promise<Artifact | undefined> {
    const artifact = this.descriptions.get(id);
    return artifact ? structuredClone(artifact) : undefined;
  }
}

export class FileArtifactStore implements ArtifactStore {
  constructor(
    private readonly directory: string,
    private readonly options: { maxBytes?: number } = {},
  ) {}

  async put(
    content: string | Uint8Array,
    options: { contentType?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<Artifact> {
    const id = randomUUID();
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
    this.assertSize(size);
    await mkdir(this.directory, { recursive: true });
    const artifact = describe(id, content, options);
    await writeFile(path.join(this.directory, `${id}.data`), content, { mode: 0o600 });
    await writeFile(path.join(this.directory, `${id}.json`), JSON.stringify(artifact), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return artifact;
  }

  async get(id: string): Promise<Uint8Array | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid artifact ID');
    try {
      const content = await readFile(path.join(this.directory, `${id}.data`));
      this.assertSize(content.byteLength);
      return content;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async describe(id: string): Promise<Artifact | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid artifact ID');
    try {
      return JSON.parse(
        await readFile(path.join(this.directory, `${id}.json`), 'utf8'),
      ) as Artifact;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private assertSize(size: number): void {
    const maximum = this.options.maxBytes ?? 25 * 1024 * 1024;
    if (size > maximum) {
      throw new AgentHarnessError(
        `Artifact is ${size} bytes; maximum is ${maximum}`,
        'ARTIFACT_TOO_LARGE',
      );
    }
  }
}

function describe(
  id: string,
  content: string | Uint8Array,
  options: { contentType?: string; metadata?: Record<string, unknown> },
): Artifact {
  return {
    id,
    contentType: options.contentType ?? 'text/plain',
    size: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength,
    createdAt: new Date().toISOString(),
    metadata: structuredClone(options.metadata ?? {}),
  };
}

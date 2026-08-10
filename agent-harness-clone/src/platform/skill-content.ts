import { S3Client } from '@aws-sdk/client-s3';
import type { ContentStore } from '../content/content-store.js';
import { S3ContentStore } from '../content/s3-content-store.js';
import { parseS3Uri, type S3Location } from '../content/s3-uri.js';

/** Maximum size of one downloaded `SKILL.md`. */
export const SKILL_MAX_OBJECT_BYTES = 2_000_000;
/** A missing or unresponsive object must fail preparation rather than hold a run open. */
export const SKILL_REQUEST_TIMEOUT_MS = 15_000;

/** Shared so one client/socket pool serves every invocation in this process. */
const clients = new Map<string, S3Client>();

export type SkillContentOptions = {
  /**
   * Replaces S3 for every skill. Used by tests and by hosts with their own content
   * adapter. Production headless runs normally leave this absent.
   */
  contentStore?: ContentStore | undefined;
  /** Injected in tests. Defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv | undefined;
};

/**
 * Resolves each skill URI and caches one SDK-backed reader per bucket.
 *
 * Credentials never come from the invocation. `S3ContentStore` uses the AWS SDK's
 * standard provider chain, which means an AgentCore execution role works without
 * copying keys into either the environment or the payload. Region resolution follows
 * the same chain; `PLATFORM_CONTENT_S3_REGION` remains as a compatibility fallback.
 */
export class SkillContentStores {
  private readonly stores = new Map<string, ContentStore>();

  constructor(private readonly options: SkillContentOptions = {}) {}

  locate(uri: string, context: string): { location: S3Location; store: ContentStore } {
    const location = parseS3Uri(uri, context);
    return { location, store: this.forBucket(location.bucket) };
  }

  private forBucket(bucket: string): ContentStore {
    if (this.options.contentStore) return this.options.contentStore;
    const existing = this.stores.get(bucket);
    if (existing) return existing;

    const environment = this.options.environment ?? process.env;
    const region = environment.AWS_REGION?.trim() || environment.PLATFORM_CONTENT_S3_REGION?.trim();
    const created = new S3ContentStore({
      bucket,
      ...(region ? { region } : {}),
      client: clientFor(region),
      requestTimeoutMs: SKILL_REQUEST_TIMEOUT_MS,
      maxObjectBytes: SKILL_MAX_OBJECT_BYTES,
    });
    this.stores.set(bucket, created);
    return created;
  }
}

function clientFor(region: string | undefined): S3Client {
  const key = region ?? '<default>';
  const existing = clients.get(key);
  if (existing) return existing;
  const created = new S3Client(region === undefined ? {} : { region });
  clients.set(key, created);
  return created;
}

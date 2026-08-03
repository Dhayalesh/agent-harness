import type { ContentStore } from '../content/content-store.js';
import { S3ContentStore } from '../content/s3-content-store.js';
import { AgentHarnessError } from '../core/errors.js';
import { parseS3Uri, type S3Location } from '../content/s3-uri.js';

/**
 * Ceiling for one skill document, and the budget for one request to fetch it.
 *
 * Constants rather than configuration. They exist to stop an unbounded response being
 * buffered and a hung request holding a run open, and neither of those is a per-
 * deployment decision — a `SKILL.md` above 2MB is a mistake in every deployment. Making
 * them tunable would only add two variables that nobody sets correctly.
 */
export const SKILL_MAX_OBJECT_BYTES = 2_000_000;
export const SKILL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The credential every skill read is signed with, from the environment.
 *
 * One region and one key pair for the whole platform. A skill record says which bucket
 * and which key, so nothing about *where* is configured here, and nothing about the
 * credential is in MongoDB.
 *
 * The tradeoff, stated plainly: whoever can set these variables chooses the identity
 * that reads skill documents, and a skill document is what an agent is told to do. The
 * bucket's own IAM policy is what bounds that, so scope the key to the prefixes holding
 * skills rather than to the account.
 */
export type SkillContentEnvironmentConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function skillContentConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SkillContentEnvironmentConfig {
  return {
    region: required(environment, 'PLATFORM_CONTENT_S3_REGION'),
    accessKeyId: required(environment, 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: required(environment, 'AWS_SECRET_ACCESS_KEY'),
  };
}

export type SkillContentOptions = {
  environment?: NodeJS.ProcessEnv;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImplementation?: typeof fetch | undefined;
  /**
   * Replaces every reader, so no environment is read and no request is made. Only the
   * test suite passes one.
   */
  contentStore?: ContentStore | undefined;
};

/**
 * Hands out one reader per bucket, reading the credential from the environment once.
 *
 * A run may touch several buckets, since each skill carries its own address, so the
 * readers are cached by bucket rather than rebuilt per skill. The environment is read
 * lazily: an agent with no skills should not require AWS variables to resolve.
 */
export class SkillContentStores {
  private readonly stores = new Map<string, ContentStore>();
  private config?: SkillContentEnvironmentConfig;

  constructor(private readonly options: SkillContentOptions = {}) {}

  /** Resolves a stored address, then returns the reader for the bucket it names. */
  locate(uri: string, context: string): { location: S3Location; store: ContentStore } {
    const location = parseS3Uri(uri, context);
    return { location, store: this.for(location.bucket, context) };
  }

  private for(bucket: string, context: string): ContentStore {
    if (this.options.contentStore) return this.options.contentStore;
    const existing = this.stores.get(bucket);
    if (existing) return existing;

    if (!this.config) {
      try {
        this.config = skillContentConfigFromEnvironment(this.options.environment ?? process.env);
      } catch (error) {
        if (!(error instanceof AgentHarnessError)) throw error;
        throw new AgentHarnessError(`${context}: ${error.message}`, error.code, error.recoverable, {
          cause: error,
        });
      }
    }
    const store = new S3ContentStore({
      bucket,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      requestTimeoutMs: SKILL_REQUEST_TIMEOUT_MS,
      maxObjectBytes: SKILL_MAX_OBJECT_BYTES,
      ...(this.options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: this.options.fetchImplementation }),
    });
    this.stores.set(bucket, store);
    return store;
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value !== undefined && value !== '') return value;
  throw new AgentHarnessError(
    `${name} is not set, so no S3 read can be signed. Set PLATFORM_CONTENT_S3_REGION, ` +
      'AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY in .env.',
    'SKILL_CONTENT_NOT_CONFIGURED',
  );
}

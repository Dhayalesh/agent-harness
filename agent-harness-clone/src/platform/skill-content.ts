import type { ContentStore } from '../content/content-store.js';
import { AgentHarnessError } from '../core/errors.js';
import { parseS3Uri, type S3Location } from '../content/s3-uri.js';

/**
 * Ceiling for one skill document.
 *
 * A constant rather than configuration. It exists to stop an unbounded body being
 * carried on a request, and that is not a per-deployment decision — a `SKILL.md`
 * above 2MB is a mistake in every deployment. Making it tunable would only add a
 * variable nobody sets correctly.
 */
export const SKILL_MAX_OBJECT_BYTES = 2_000_000;

export type SkillContentOptions = {
  /**
   * Where skill documents are read from.
   *
   * There is no default and no fallback reader, which is the whole point: a skill
   * body arrives on the invocation payload and is served from memory, so this
   * process reads no bucket and holds no storage credential. An earlier version
   * signed S3 reads from `PLATFORM_CONTENT_S3_REGION` and an AWS key pair; that
   * path is gone along with every other source of configuration outside the
   * payload.
   *
   * Optional only so an agent with no skills needs nothing supplied. A record that
   * references a skill without one is a coded error, not a silent skip.
   */
  contentStore?: ContentStore | undefined;
};

/**
 * Resolves a skill record's stored address to the reader for it.
 *
 * The indirection survives the move to payload-only skills because
 * `PlatformAgentRegistry` locates every skill through an address, and keeping that
 * shape means the inline path and the assembly path are the same code. What changed
 * is that there is now exactly one reader, supplied by the caller, instead of one
 * built per bucket from the environment.
 */
export class SkillContentStores {
  constructor(private readonly options: SkillContentOptions) {}

  /** Resolves a stored address, then returns the reader for it. */
  locate(uri: string, context: string): { location: S3Location; store: ContentStore } {
    const location = parseS3Uri(uri, context);
    if (!this.options.contentStore) {
      throw new AgentHarnessError(
        `${context}: no content store was supplied, so there is nowhere to read the skill from. ` +
          'Skill bodies travel on the invocation payload; see src/headless/payload.ts.',
        'SKILL_CONTENT_NOT_CONFIGURED',
      );
    }
    return { location, store: this.options.contentStore };
  }
}

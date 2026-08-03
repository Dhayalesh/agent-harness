import { createHash } from 'node:crypto';
import { AgentHarnessError } from '../core/errors.js';

/**
 * Where one document lives, and what it must contain.
 *
 * The content is addressed by `key` but *identified* by `sha256`: a store returns
 * bytes, and the caller only accepts them when they hash to the value recorded in
 * MongoDB. Whoever can overwrite the object therefore cannot change what an agent
 * does, because the overwritten object no longer matches the reference. Without
 * that, a bucket write would silently rewrite a system prompt with nothing in the
 * database to show it happened.
 *
 * `bytes` is carried too so a store can refuse an oversized body before reading
 * it, rather than buffering an unbounded response to find out.
 */
export type ContentLocation = {
  key: string;
  sha256: string;
  bytes: number;
};

/**
 * Bytes, and the reference derived from them, out of one round trip.
 *
 * A skill record names a bucket and a key and nothing else, so there is no stored
 * digest to check the body against; the digest is computed from what arrived
 * instead. It is returned with the text rather than fetched separately because a
 * `describe` followed by a `read` is two GETs of an object that may change between
 * them, and would report a digest the caller never actually used.
 */
export type LoadedContent = {
  location: ContentLocation;
  text: string;
};

/**
 * Reads and writes the Markdown documents an agent is built from.
 *
 * The runtime needs `load` and `read`: `load` when the record is only a pointer,
 * `read` when it also carries a digest to hold the bytes to. `write` exists for the
 * operator scripts, which upload a document; nothing on a run path calls it.
 */
export interface ContentStore {
  read(location: ContentLocation): Promise<string>;
  write(key: string, text: string): Promise<ContentLocation>;
  /**
   * Fetches the object at `key` with no reference to check it against.
   *
   * This is the read a skill uses, since a `skills` record stores only where the
   * document is. Nothing is verified, so the bytes are trusted exactly as far as
   * whoever can write the bucket is trusted; the size ceiling on the bucket record
   * still applies.
   */
  load(key: string): Promise<LoadedContent>;
  /**
   * Fetches the object at `key` and derives the reference for it, discarding the
   * body.
   *
   * Separate from `read` because `read` verifies bytes against a digest it was
   * given, which is useless when the digest is the thing being determined. Only the
   * operator scripts call this.
   */
  describe(key: string): Promise<ContentLocation>;
  /** Human-readable target, for error messages and startup logs. */
  readonly description: string;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The location a document would have, without storing it. */
export function locate(key: string, text: string): ContentLocation {
  return { key, sha256: sha256Hex(text), bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Verifies bytes against the reference that named them. Shared by every
 * implementation so the check cannot be skipped by one of them.
 */
export function assertMatches(location: ContentLocation, text: string, source: string): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes !== location.bytes) {
    throw new AgentHarnessError(
      `Content at ${source} is ${bytes} bytes, but the reference records ${location.bytes}. ` +
        'The object changed after the reference was stored, so it is refused rather than used.',
      'CONTENT_SIZE_MISMATCH',
    );
  }
  const digest = sha256Hex(text);
  if (digest !== location.sha256) {
    throw new AgentHarnessError(
      `Content at ${source} hashes to ${digest}, but the reference records ${location.sha256}. ` +
        'The object was replaced after the reference was stored, so it is refused rather than ' +
        'used.',
      'CONTENT_CHECKSUM_MISMATCH',
    );
  }
  return text;
}

/**
 * Test double. Not a storage mode: no record can point at it, because a stored address
 * names an S3 bucket and this is not one. It exists so the suite can exercise
 * resolution without reaching S3.
 */
export class InMemoryContentStore implements ContentStore {
  readonly description = 'in-memory';
  private readonly documents = new Map<string, string>();

  constructor(documents: Readonly<Record<string, string>> = {}) {
    for (const [key, text] of Object.entries(documents)) this.documents.set(key, text);
  }

  async read(location: ContentLocation): Promise<string> {
    const text = this.documents.get(location.key);
    if (text === undefined) {
      throw new AgentHarnessError(
        `No content at ${location.key} in the in-memory store`,
        'CONTENT_NOT_FOUND',
      );
    }
    return assertMatches(location, text, location.key);
  }

  async write(key: string, text: string): Promise<ContentLocation> {
    this.documents.set(key, text);
    return locate(key, text);
  }

  async load(key: string): Promise<LoadedContent> {
    const text = this.documents.get(key);
    if (text === undefined) {
      throw new AgentHarnessError(
        `No content at ${key} in the in-memory store`,
        'CONTENT_NOT_FOUND',
      );
    }
    return { location: locate(key, text), text };
  }

  async describe(key: string): Promise<ContentLocation> {
    return (await this.load(key)).location;
  }
}

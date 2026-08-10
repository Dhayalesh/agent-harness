import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentHarnessError } from '../core/errors.js';
import {
  assertSessionSize,
  isExpired,
  type SessionStore,
  type SessionStoreOptions,
  type StoredSession,
  validateStoredSession,
} from './session-store.js';

export class FileSessionStore implements SessionStore {
  readonly kind = 'file' as const;
  private readonly directory: string;
  private lastSweepAt = 0;

  constructor(
    directory: string,
    private readonly options: SessionStoreOptions = {},
  ) {
    this.directory = path.resolve(directory);
  }

  async load(id: string): Promise<StoredSession | undefined> {
    const target = this.pathFor(id);
    try {
      const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
      const session = validateStoredSession(parsed);
      if (isExpired(session, this.options.ttlMs)) {
        await rm(target).catch((cleanupError: unknown) => {
          if (!isNotFound(cleanupError)) throw cleanupError;
        });
        return undefined;
      }
      return session;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(session: StoredSession): Promise<void> {
    assertSessionSize(session, this.options.maxBytes);
    await mkdir(this.directory, { recursive: true });
    await this.sweepExpiredIfDue();
    const target = this.pathFor(session.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(session)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.pathFor(id));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    try {
      const entries = await readdir(this.directory);
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => this.load(entry.slice(0, -5))),
      );
      return sessions
        .filter((session): session is StoredSession => session !== undefined)
        .map(({ id, createdAt, updatedAt, metadata }) => ({
          id,
          createdAt,
          updatedAt,
          metadata,
        }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private pathFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new AgentHarnessError('Invalid session ID', 'INVALID_SESSION_ID');
    }
    return path.join(this.directory, `${id}.json`);
  }

  /** Opportunistic cleanup keeps one-off invocation IDs from accumulating forever. */
  private async sweepExpiredIfDue(): Promise<void> {
    const ttlMs = this.options.ttlMs ?? 0;
    if (ttlMs <= 0) return;
    const now = Date.now();
    const interval = Math.max(60_000, Math.min(15 * 60_000, Math.floor(ttlMs / 4)));
    if (now - this.lastSweepAt < interval) return;
    this.lastSweepAt = now;
    const entries = await readdir(this.directory);
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        // A corrupt unrelated record must not prevent the current session from
        // being saved. Loading that specific id still reports the corruption.
        .map((entry) => this.load(entry.slice(0, -5)).catch(() => undefined)),
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

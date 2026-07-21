import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentHarnessError } from '../core/errors.js';
import type { SessionStore, StoredSession } from './session-store.js';

export class FileSessionStore implements SessionStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  async load(id: string): Promise<StoredSession | undefined> {
    const target = this.pathFor(id);
    try {
      const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
      return validateStoredSession(parsed);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(session: StoredSession): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(session.id);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, target);
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
}

function validateStoredSession(value: unknown): StoredSession {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('messages' in value) ||
    !Array.isArray(value.messages)
  ) {
    throw new AgentHarnessError('Stored session is invalid', 'INVALID_STORED_SESSION');
  }
  return value as StoredSession;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

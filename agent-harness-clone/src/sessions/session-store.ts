import type { AgentMessage } from '../core/messages.js';
import { AgentHarnessError } from '../core/errors.js';

export type StoredSession = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  metadata: Record<string, unknown>;
};

export type SessionStoreOptions = {
  /** Expire inactive sessions after this many milliseconds. Zero disables expiry. */
  ttlMs?: number;
  /** Maximum serialized size of one session. Defaults to 10 MiB. */
  maxBytes?: number;
};

export interface SessionStore {
  readonly kind?: 'memory' | 'file' | 's3' | 'custom';
  load(id: string): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>>;
}

export class InMemorySessionStore implements SessionStore {
  readonly kind = 'memory' as const;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly options: SessionStoreOptions = {}) {}

  async load(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    if (session && isExpired(session, this.options.ttlMs)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session ? structuredClone(session) : undefined;
  }

  async save(session: StoredSession): Promise<void> {
    assertSessionSize(session, this.options.maxBytes);
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    for (const [id, session] of this.sessions) {
      if (isExpired(session, this.options.ttlMs)) this.sessions.delete(id);
    }
    return [...this.sessions.values()].map(({ id, createdAt, updatedAt, metadata }) => ({
      id,
      createdAt,
      updatedAt,
      metadata: structuredClone(metadata),
    }));
  }
}

export function isExpired(session: StoredSession, ttlMs = 0, now = Date.now()): boolean {
  if (ttlMs <= 0) return false;
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt + ttlMs <= now;
}

export function assertSessionSize(session: StoredSession, maximum = 10 * 1024 * 1024): void {
  const bytes = Buffer.byteLength(JSON.stringify(session), 'utf8');
  if (bytes > maximum) {
    throw new AgentHarnessError(
      `Session ${session.id} is ${bytes} bytes; maximum is ${maximum}`,
      'SESSION_TOO_LARGE',
    );
  }
}

export function validateStoredSession(value: unknown): StoredSession {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string' ||
    !('messages' in value) ||
    !Array.isArray(value.messages) ||
    !('metadata' in value) ||
    typeof value.metadata !== 'object' ||
    value.metadata === null ||
    Array.isArray(value.metadata)
  ) {
    throw new AgentHarnessError('Stored session is invalid', 'INVALID_STORED_SESSION');
  }
  return value as StoredSession;
}

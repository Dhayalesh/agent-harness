import type { AgentMessage } from '../core/messages.js';

export type StoredSession = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  metadata: Record<string, unknown>;
};

export interface SessionStore {
  load(id: string): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async load(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async save(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    return [...this.sessions.values()].map(({ id, createdAt, updatedAt, metadata }) => ({
      id,
      createdAt,
      updatedAt,
      metadata: structuredClone(metadata),
    }));
  }
}

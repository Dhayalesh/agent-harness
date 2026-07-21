import type { AgentEvent } from '../core/events.js';

export type PlatformSessionRecord = {
  sessionId: string;
  tenantId: string;
  ownerId: string;
  agentIdOrSlug: string;
  environment: string;
  controlTokenHash: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
};

export type PlatformRunRecord = {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  error?: string;
};

export type StoredPlatformEvent = {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  sequence: number;
  event: AgentEvent;
  createdAt: string;
};

export interface PlatformRuntimeStore {
  initialize(): Promise<void>;
  recoverOrphanedRuns(updatedAt: string): Promise<number>;
  createSession(record: PlatformSessionRecord): Promise<void>;
  getSession(tenantId: string, sessionId: string): Promise<PlatformSessionRecord | undefined>;
  listSessions(
    tenantId: string,
    ownerId?: string,
    limit?: number,
  ): Promise<PlatformSessionRecord[]>;
  closeSession(tenantId: string, sessionId: string, updatedAt: string): Promise<boolean>;
  claimRun(record: PlatformRunRecord): Promise<boolean>;
  getRun(
    tenantId: string,
    sessionId: string,
    runId: string,
  ): Promise<PlatformRunRecord | undefined>;
  finishRun(
    tenantId: string,
    sessionId: string,
    runId: string,
    status: Exclude<PlatformRunRecord['status'], 'running'>,
    updatedAt: string,
    error?: string,
  ): Promise<void>;
  appendEvent(record: StoredPlatformEvent): Promise<void>;
  listEvents(tenantId: string, sessionId: string, afterSequence?: number): Promise<AgentEvent[]>;
  listRunEvents(tenantId: string, sessionId: string, runId: string): Promise<AgentEvent[]>;
  close(): Promise<void>;
}

export class InMemoryPlatformRuntimeStore implements PlatformRuntimeStore {
  private readonly sessions = new Map<string, PlatformSessionRecord>();
  private readonly runs = new Map<string, PlatformRunRecord>();
  private readonly events: StoredPlatformEvent[] = [];

  async initialize(): Promise<void> {}

  async recoverOrphanedRuns(updatedAt: string): Promise<number> {
    let recovered = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      run.status = 'failed';
      run.updatedAt = updatedAt;
      run.error = 'API process stopped before the run completed';
      recovered += 1;
    }
    return recovered;
  }

  async createSession(record: PlatformSessionRecord): Promise<void> {
    const key = sessionKey(record.tenantId, record.sessionId);
    if (this.sessions.has(key))
      throw new Error(`Platform session already exists: ${record.sessionId}`);
    this.sessions.set(key, structuredClone(record));
  }

  async getSession(
    tenantId: string,
    sessionId: string,
  ): Promise<PlatformSessionRecord | undefined> {
    const value = this.sessions.get(sessionKey(tenantId, sessionId));
    return value ? structuredClone(value) : undefined;
  }

  async listSessions(
    tenantId: string,
    ownerId?: string,
    limit = 100,
  ): Promise<PlatformSessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.tenantId === tenantId && (ownerId === undefined || session.ownerId === ownerId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((session) => structuredClone(session));
  }

  async closeSession(tenantId: string, sessionId: string, updatedAt: string): Promise<boolean> {
    const value = this.sessions.get(sessionKey(tenantId, sessionId));
    if (!value) return false;
    value.status = 'closed';
    value.updatedAt = updatedAt;
    return true;
  }

  async claimRun(record: PlatformRunRecord): Promise<boolean> {
    const key = runKey(record.tenantId, record.sessionId, record.runId);
    if (this.runs.has(key)) return false;
    this.runs.set(key, structuredClone(record));
    return true;
  }

  async getRun(
    tenantId: string,
    sessionId: string,
    runId: string,
  ): Promise<PlatformRunRecord | undefined> {
    const value = this.runs.get(runKey(tenantId, sessionId, runId));
    return value ? structuredClone(value) : undefined;
  }

  async finishRun(
    tenantId: string,
    sessionId: string,
    runId: string,
    status: Exclude<PlatformRunRecord['status'], 'running'>,
    updatedAt: string,
    error?: string,
  ): Promise<void> {
    const value = this.runs.get(runKey(tenantId, sessionId, runId));
    if (!value) throw new Error(`Unknown platform run: ${runId}`);
    value.status = status;
    value.updatedAt = updatedAt;
    if (error !== undefined) value.error = error;
  }

  async appendEvent(record: StoredPlatformEvent): Promise<void> {
    if (
      this.events.some(
        (event) =>
          event.tenantId === record.tenantId &&
          event.sessionId === record.sessionId &&
          event.sequence === record.sequence,
      )
    ) {
      throw new Error(`Duplicate platform event sequence: ${record.sequence}`);
    }
    this.events.push(structuredClone(record));
  }

  async listEvents(tenantId: string, sessionId: string, afterSequence = 0): Promise<AgentEvent[]> {
    return this.events
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          record.sessionId === sessionId &&
          record.sequence > afterSequence,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => structuredClone(record.event));
  }

  async listRunEvents(tenantId: string, sessionId: string, runId: string): Promise<AgentEvent[]> {
    return this.events
      .filter(
        (record) =>
          record.tenantId === tenantId && record.sessionId === sessionId && record.runId === runId,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => structuredClone(record.event));
  }

  async close(): Promise<void> {}
}

function sessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

function runKey(tenantId: string, sessionId: string, runId: string): string {
  return `${tenantId}:${sessionId}:${runId}`;
}

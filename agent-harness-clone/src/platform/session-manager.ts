import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentSession } from '../core/agent-session.js';
import type { AgentEvent } from '../core/events.js';
import type { PlatformPrincipal } from './definitions.js';
import { newId, nowIso } from './definitions.js';
import type { PlatformRuntimeStore } from './runtime-state.js';
import type { PlatformRunRecord, PlatformSessionRecord } from './runtime-state.js';

type ActiveSession = {
  session: AgentSession;
  tenantId: string;
  ownerId: string;
  controlTokenHash: string;
};

export type PlatformSessionHandle = {
  sessionId: string;
  controlToken: string;
  agentIdOrSlug: string;
  environment: string;
};

export type PublicPlatformSessionRecord = Omit<PlatformSessionRecord, 'controlTokenHash'>;

export type PlatformAgentSessionFactory = {
  createSession(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment?: string,
  ): Promise<AgentSession>;
  resumeSession(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment: string,
    sessionId: string,
  ): Promise<AgentSession>;
};

export class AgentPlatformSessionManager {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly execution: PlatformAgentSessionFactory,
    private readonly store: PlatformRuntimeStore,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.recoverOrphanedRuns(nowIso());
  }

  async create(
    principal: PlatformPrincipal,
    agentIdOrSlug: string,
    environment = 'production',
  ): Promise<PlatformSessionHandle> {
    const session = await this.execution.createSession(principal, agentIdOrSlug, environment);
    const controlToken = randomBytes(32).toString('base64url');
    const controlTokenHash = hashControlToken(controlToken);
    const createdAt = nowIso();
    try {
      await this.store.createSession({
        sessionId: session.id,
        tenantId: principal.tenantId,
        ownerId: principal.userId,
        agentIdOrSlug,
        environment,
        controlTokenHash,
        status: 'open',
        createdAt,
        updatedAt: createdAt,
      });
    } catch (error) {
      await session.close();
      throw error;
    }
    this.active.set(session.id, {
      session,
      tenantId: principal.tenantId,
      ownerId: principal.userId,
      controlTokenHash,
    });
    return { sessionId: session.id, controlToken, agentIdOrSlug, environment };
  }

  async *streamRun(
    principal: PlatformPrincipal,
    sessionId: string,
    controlToken: string,
    prompt: string,
    runId: string = randomUUID(),
  ): AsyncIterable<AgentEvent> {
    const active = await this.authorizeControl(principal, sessionId, controlToken);
    const createdAt = nowIso();
    const claimed = await this.store.claimRun({
      id: newId(),
      tenantId: principal.tenantId,
      sessionId,
      runId,
      status: 'running',
      createdAt,
      updatedAt: createdAt,
    });
    if (!claimed) {
      const existing = await this.store.getRun(principal.tenantId, sessionId, runId);
      if (existing?.status === 'completed' || existing?.status === 'cancelled') {
        for (const event of await this.store.listRunEvents(principal.tenantId, sessionId, runId)) {
          yield event;
        }
        return;
      }
      throw new Error(`Run is already active or failed: ${runId}`);
    }
    const previousEvents = await this.store.listEvents(principal.tenantId, sessionId);
    const lastSequence = previousEvents.at(-1)?.sequence ?? 0;
    let latestSequence = lastSequence;
    let sequenceOffset: number | undefined;
    try {
      for await (const emittedEvent of active.session.run({ prompt })) {
        sequenceOffset ??= Math.max(0, lastSequence - emittedEvent.sequence + 1);
        const event =
          sequenceOffset === 0
            ? emittedEvent
            : { ...emittedEvent, sequence: emittedEvent.sequence + sequenceOffset };
        latestSequence = event.sequence;
        await this.store.appendEvent({
          id: newId(),
          tenantId: principal.tenantId,
          sessionId,
          runId,
          sequence: event.sequence,
          event,
          createdAt: event.timestamp,
        });
        yield event;
      }
      await this.store.finishRun(principal.tenantId, sessionId, runId, 'completed', nowIso());
    } catch (error) {
      const status =
        error instanceof Error && /interrupt|abort|cancel/i.test(error.message)
          ? 'cancelled'
          : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      const event: AgentEvent = {
        protocolVersion: 1,
        sequence: latestSequence + 1,
        timestamp: nowIso(),
        sessionId,
        type: 'error',
        code: status === 'cancelled' ? 'RUN_CANCELLED' : 'RUN_FAILED',
        message,
        recoverable: status === 'cancelled',
      };
      await this.store.appendEvent({
        id: newId(),
        tenantId: principal.tenantId,
        sessionId,
        runId,
        sequence: event.sequence,
        event,
        createdAt: event.timestamp,
      });
      yield event;
      await this.store.finishRun(principal.tenantId, sessionId, runId, status, nowIso(), message);
      throw error;
    }
  }

  async replay(
    principal: PlatformPrincipal,
    sessionId: string,
    afterSequence = 0,
  ): Promise<AgentEvent[]> {
    await this.authorizeView(principal, sessionId);
    return this.store.listEvents(principal.tenantId, sessionId, afterSequence);
  }

  async list(principal: PlatformPrincipal, limit = 100): Promise<PublicPlatformSessionRecord[]> {
    const records = await this.store.listSessions(
      principal.tenantId,
      principal.roles.includes('admin') ? undefined : principal.userId,
      limit,
    );
    return records.map(({ controlTokenHash: _controlTokenHash, ...record }) => record);
  }

  async getRun(
    principal: PlatformPrincipal,
    sessionId: string,
    runId: string,
  ): Promise<PlatformRunRecord> {
    await this.authorizeView(principal, sessionId);
    const run = await this.store.getRun(principal.tenantId, sessionId, runId);
    if (!run) throw new Error(`Unknown platform run: ${runId}`);
    return run;
  }

  async respondToPermission(
    principal: PlatformPrincipal,
    sessionId: string,
    controlToken: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<boolean> {
    const active = await this.authorizeControl(principal, sessionId, controlToken);
    return active.session.respondToPermission(requestId, decision);
  }

  async interrupt(
    principal: PlatformPrincipal,
    sessionId: string,
    controlToken: string,
    reason = 'platform interrupt',
  ): Promise<void> {
    const active = await this.authorizeControl(principal, sessionId, controlToken);
    active.session.interrupt(reason);
  }

  async close(
    principal: PlatformPrincipal,
    sessionId: string,
    controlToken: string,
  ): Promise<void> {
    const active = await this.authorizeControl(principal, sessionId, controlToken);
    await active.session.close();
    this.active.delete(sessionId);
    await this.store.closeSession(principal.tenantId, sessionId, nowIso());
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.allSettled(sessions.map((active) => active.session.close()));
  }

  private async authorizeControl(
    principal: PlatformPrincipal,
    sessionId: string,
    controlToken: string,
  ): Promise<ActiveSession> {
    const record = await this.store.getSession(principal.tenantId, sessionId);
    if (!record || record.status !== 'open') throw new Error(`Unknown open session: ${sessionId}`);
    if (record.ownerId !== principal.userId && !principal.roles.includes('admin')) {
      throw new Error('Session control denied');
    }
    if (record.controlTokenHash !== hashControlToken(controlToken)) {
      throw new Error('Session control denied');
    }
    const active = this.active.get(sessionId);
    if (active) return active;
    const session = await this.execution.resumeSession(
      principal,
      record.agentIdOrSlug,
      record.environment,
      sessionId,
    );
    const resumed: ActiveSession = {
      session,
      tenantId: record.tenantId,
      ownerId: record.ownerId,
      controlTokenHash: record.controlTokenHash,
    };
    this.active.set(sessionId, resumed);
    return resumed;
  }

  private async authorizeView(principal: PlatformPrincipal, sessionId: string): Promise<void> {
    const record = await this.store.getSession(principal.tenantId, sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    if (record.ownerId !== principal.userId && !principal.roles.includes('admin')) {
      throw new Error('Session view denied');
    }
  }
}

function hashControlToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

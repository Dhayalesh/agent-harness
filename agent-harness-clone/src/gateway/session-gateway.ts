import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentSession } from '../core/agent-session.js';
import type { AgentEvent } from '../core/events.js';

export type GatewaySession = {
  sessionId: string;
  controlToken: string;
  ownerId: string;
};

type ManagedSession = {
  session: AgentSession;
  controlToken: string;
  ownerId: string;
  events: AgentEvent[];
  runs: Map<string, Promise<AgentEvent[]>>;
};

/**
 * What the caller asked for when opening a session.
 *
 * It exists so a host serving more than one stored agent can build the right
 * one. A zero-argument factory could only ever produce a single configuration,
 * which is what pinned the agent-core service to one agent: the record's system
 * prompt, tools, and skills are per-agent, so the choice has to reach the
 * factory. A zero-argument factory still satisfies this signature, so hosts that
 * serve one agent are unaffected.
 */
export type SessionRequest = {
  ownerId: string;
  /**
   * `agents.name`. Unset leaves the choice to the factory, which is the record
   * marked `isDefault` for hosts that read the platform collections.
   */
  agentName?: string;
};

export type SessionGatewayOptions = {
  createSession(request: SessionRequest): AgentSession | Promise<AgentSession>;
  maxEventsPerSession?: number;
};

export class SessionGateway {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly maxEvents: number;

  constructor(private readonly options: SessionGatewayOptions) {
    this.maxEvents = options.maxEventsPerSession ?? 20_000;
  }

  async create(ownerId: string, agentName?: string): Promise<GatewaySession> {
    const session = await this.options.createSession({
      ownerId,
      ...(agentName === undefined ? {} : { agentName }),
    });
    const controlToken = randomBytes(24).toString('base64url');
    this.sessions.set(session.id, {
      session,
      controlToken,
      ownerId,
      events: [],
      runs: new Map(),
    });
    return { sessionId: session.id, controlToken, ownerId };
  }

  async run(
    sessionId: string,
    controlToken: string,
    prompt: string,
    runId: string = randomUUID(),
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of this.streamRun(sessionId, controlToken, prompt, runId)) {
      events.push(event);
    }
    return events;
  }

  async *streamRun(
    sessionId: string,
    controlToken: string,
    prompt: string,
    runId: string = randomUUID(),
  ): AsyncIterable<AgentEvent> {
    const managed = this.authorize(sessionId, controlToken);
    const existing = managed.runs.get(runId);
    if (existing) {
      for (const event of await existing) yield structuredClone(event);
      return;
    }

    let resolveRun: (events: AgentEvent[]) => void = () => undefined;
    let rejectRun: (error: unknown) => void = () => undefined;
    const execution = new Promise<AgentEvent[]>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    managed.runs.set(runId, execution);
    const runEvents: AgentEvent[] = [];
    try {
      for await (const event of managed.session.run({ prompt })) {
        runEvents.push(event);
        managed.events.push(event);
        if (managed.events.length > this.maxEvents) managed.events.shift();
        yield structuredClone(event);
      }
      resolveRun(structuredClone(runEvents));
    } catch (error) {
      rejectRun(error);
      throw error;
    }
  }

  replay(sessionId: string, fromSequence = 0): AgentEvent[] {
    const managed = this.get(sessionId);
    return structuredClone(managed.events.filter((event) => event.sequence > fromSequence));
  }

  canView(sessionId: string, ownerId: string): boolean {
    const managed = this.sessions.get(sessionId);
    return managed?.ownerId === ownerId;
  }

  respondToPermission(
    sessionId: string,
    controlToken: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): boolean {
    return this.authorize(sessionId, controlToken).session.respondToPermission(requestId, decision);
  }

  interrupt(sessionId: string, controlToken: string, reason?: string): void {
    this.authorize(sessionId, controlToken).session.interrupt(reason);
  }

  async close(sessionId: string, controlToken: string): Promise<void> {
    const managed = this.authorize(sessionId, controlToken);
    await managed.session.close();
    this.sessions.delete(sessionId);
  }

  private authorize(sessionId: string, controlToken: string): ManagedSession {
    const managed = this.get(sessionId);
    if (managed.controlToken !== controlToken) throw new Error('Session control denied');
    return managed;
  }

  private get(sessionId: string): ManagedSession {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new Error(`Unknown session: ${sessionId}`);
    return managed;
  }
}

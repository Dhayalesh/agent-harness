import type { AgentEvent } from '../../core/events.js';
import type { GatewaySession, SessionGateway } from '../../gateway/session-gateway.js';

export class DesktopAgentAdapter {
  constructor(
    private readonly gateway: SessionGateway,
    private readonly desktopInstanceId: string,
  ) {}

  createSession(): Promise<GatewaySession> {
    return this.gateway.create(`desktop:${this.desktopInstanceId}`);
  }

  run(session: GatewaySession, prompt: string, idempotencyKey?: string): Promise<AgentEvent[]> {
    return this.gateway.run(session.sessionId, session.controlToken, prompt, idempotencyKey);
  }

  replay(sessionId: string, fromSequence?: number): AgentEvent[] {
    return this.gateway.replay(sessionId, fromSequence);
  }
}

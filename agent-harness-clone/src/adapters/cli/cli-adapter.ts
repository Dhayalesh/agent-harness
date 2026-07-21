import type { AgentSession } from '../../core/agent-session.js';
import type { AgentEvent } from '../../core/events.js';

export type CliRenderer = {
  render(event: AgentEvent): void;
};

export class CliAgentAdapter {
  constructor(private readonly renderer?: CliRenderer) {}

  async run(session: AgentSession, prompt: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of session.run({ prompt })) {
      events.push(event);
      this.renderer?.render(event);
    }
    return events;
  }
}

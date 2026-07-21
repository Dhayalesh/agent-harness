import type { AgentSession } from '../core/agent-session.js';
import type { AgentEvent } from '../core/events.js';

export type ParityDifference = {
  index: number;
  primary: unknown;
  candidate: unknown;
};

export type ParityResult = {
  matches: boolean;
  differences: ParityDifference[];
  primaryEvents: AgentEvent[];
  candidateEvents: AgentEvent[];
};

export async function runParityScenario(
  primaryFactory: () => AgentSession | Promise<AgentSession>,
  candidateFactory: () => AgentSession | Promise<AgentSession>,
  prompt: string,
): Promise<ParityResult> {
  const [primaryEvents, candidateEvents] = await Promise.all([
    run(primaryFactory, prompt),
    run(candidateFactory, prompt),
  ]);
  const primary = primaryEvents.map(normalizeEvent).filter(Boolean);
  const candidate = candidateEvents.map(normalizeEvent).filter(Boolean);
  const differences: ParityDifference[] = [];
  for (let index = 0; index < Math.max(primary.length, candidate.length); index += 1) {
    if (JSON.stringify(primary[index]) !== JSON.stringify(candidate[index])) {
      differences.push({ index, primary: primary[index], candidate: candidate[index] });
    }
  }
  return { matches: differences.length === 0, differences, primaryEvents, candidateEvents };
}

async function run(
  factory: () => AgentSession | Promise<AgentSession>,
  prompt: string,
): Promise<AgentEvent[]> {
  const session = await factory();
  const events: AgentEvent[] = [];
  try {
    for await (const event of session.run({ prompt })) events.push(event);
  } finally {
    await session.close();
  }
  return events;
}

function normalizeEvent(event: AgentEvent): unknown {
  switch (event.type) {
    case 'assistant.text.delta':
      return { type: event.type, delta: event.delta };
    case 'tool.requested':
      return { type: event.type, name: event.call.name, input: event.call.input };
    case 'tool.completed':
      return {
        type: event.type,
        content: event.result.content,
        isError: event.result.isError,
      };
    case 'turn.completed':
    case 'session.completed':
      return { type: event.type, reason: event.reason };
    case 'error':
      return { type: event.type, code: event.code, recoverable: event.recoverable };
    case 'warning':
      return { type: event.type, code: event.code };
    default:
      return undefined;
  }
}

import type { AgentEvent } from '../core/events.js';

export interface EventSink {
  onEvent(event: AgentEvent): void;
}

export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  onEvent(event: AgentEvent): void {
    for (const sink of this.sinks) sink.onEvent(event);
  }
}

export class StructuredLogSink implements EventSink {
  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  onEvent(event: AgentEvent): void {
    this.write(JSON.stringify({ component: 'agent-harness', ...event }));
  }
}

export type HarnessMetrics = {
  sessionsStarted: number;
  sessionsCompleted: number;
  turnsStarted: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
};

export class MetricsSink implements EventSink {
  private readonly values: HarnessMetrics = {
    sessionsStarted: 0,
    sessionsCompleted: 0,
    turnsStarted: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    errors: 0,
  };

  onEvent(event: AgentEvent): void {
    if (event.type === 'session.started') this.values.sessionsStarted += 1;
    if (event.type === 'session.completed') this.values.sessionsCompleted += 1;
    if (event.type === 'turn.started') this.values.turnsStarted += 1;
    if (event.type === 'tool.started') this.values.toolCalls += 1;
    if (event.type === 'tool.completed' && event.result.isError) this.values.toolErrors += 1;
    if (event.type === 'usage.updated') {
      this.values.inputTokens += event.usage.inputTokens;
      this.values.outputTokens += event.usage.outputTokens;
    }
    if (event.type === 'error') this.values.errors += 1;
  }

  snapshot(): HarnessMetrics {
    return structuredClone(this.values);
  }
}

export class NotificationSink implements EventSink {
  constructor(
    private readonly notify: (notification: {
      title: string;
      message: string;
      sessionId: string;
    }) => void,
  ) {}

  onEvent(event: AgentEvent): void {
    if (event.type === 'session.completed') {
      this.notify({
        title: 'Agent session completed',
        message: `Reason: ${event.reason}`,
        sessionId: event.sessionId,
      });
    }
    if (event.type === 'error') {
      this.notify({
        title: 'Agent session error',
        message: event.message,
        sessionId: event.sessionId,
      });
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/events.js';
import { REDACTED, redact } from './redact.js';

export const REDACTED_LOG_VALUE = REDACTED;

export type HarnessLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  invocationId?: string;
  requestId?: string;
  runtimeSessionId?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  [key: string]: unknown;
};

export type HarnessLogEntry = {
  event: string;
  level?: HarnessLogLevel;
  timestamp?: string;
  message?: unknown;
  [key: string]: unknown;
};

export interface LogSink {
  log(entry: HarnessLogEntry): void;
}

/** Logging is fail-open everywhere: a broken sink cannot fail an invocation. */
export function emitLog(sink: LogSink | undefined, entry: HarnessLogEntry): void {
  try {
    sink?.log(entry);
  } catch {
    // Observability is never an execution dependency.
  }
}

export interface EventSink {
  onEvent(event: AgentEvent): void;
}

export class CompositeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  onEvent(event: AgentEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.onEvent(event);
      } catch {
        // One optional sink must not starve the others.
      }
    }
  }
}

export const DEFAULT_MAX_LOG_LINE_BYTES = 240_000;

export type StructuredLogSinkOptions = {
  context?: LogContext;
  component?: string;
  maxLineBytes?: number;
  clock?: () => Date;
  fallbackWrite?: (line: string) => void;
};

/**
 * CloudWatch-ready JSON lines for AgentEvents and the wider invocation lifecycle.
 * Credentials are removed and oversized records become ordered JSON fragments.
 */
export class StructuredLogSink implements EventSink, LogSink {
  private readonly context: LogContext;
  private readonly component: string;
  private readonly maxLineBytes: number;
  private readonly clock: () => Date;
  private readonly fallbackWrite: (line: string) => void;

  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(line + '\n'),
    options: StructuredLogSinkOptions = {},
  ) {
    this.context = options.context ?? {};
    this.component = options.component ?? 'agent-harness';
    this.maxLineBytes = Math.max(4_096, options.maxLineBytes ?? DEFAULT_MAX_LOG_LINE_BYTES);
    this.clock = options.clock ?? (() => new Date());
    this.fallbackWrite = options.fallbackWrite ?? ((line) => process.stderr.write(line + '\n'));
  }

  onEvent(event: AgentEvent): void {
    const { type, ...fields } = event;
    this.log({
      event: type,
      // `type` was the original StructuredLogSink schema. Keep it while `event`
      // gives lifecycle and AgentEvent records one field to query.
      type,
      level: agentEventLevel(event),
      ...fields,
      ...agentEventCorrelation(event),
    });
  }

  log(entry: HarnessLogEntry): void {
    try {
      const timestamp = entry.timestamp ?? this.clock().toISOString();
      const record = redact({
        component: this.component,
        ...this.context,
        ...entry,
        level: entry.level ?? 'info',
        timestamp,
      });
      const serialized = safeSerialize(record);
      const correlation = correlationFields(record);
      const lines = logLines(
        serialized,
        entry.event,
        timestamp,
        entry.level ?? 'info',
        this.maxLineBytes,
        this.component,
        correlation,
      );
      for (const line of lines) this.write(line);
    } catch (error) {
      try {
        this.fallbackWrite(
          JSON.stringify({
            timestamp: this.clock().toISOString(),
            level: 'error',
            component: this.component,
            event: 'observability.write.failed',
            errorName: error instanceof Error ? error.name : 'Error',
            message: 'Structured log writer failed',
          }),
        );
      } catch {
        // There is deliberately no third logging dependency.
      }
    }
  }
}

export function redactCredentials(value: unknown): unknown {
  return redact(value);
}

export function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    });
  }
}

function logLines(
  serialized: string,
  originalEvent: string,
  timestamp: string,
  level: HarnessLogLevel,
  maximumBytes: number,
  component: string,
  correlation: Record<string, unknown>,
): string[] {
  if (Buffer.byteLength(serialized, 'utf8') <= maximumBytes) return [serialized];

  const chunkId = randomUUID();
  const pieces: string[] = [];
  let offset = 0;
  while (offset < serialized.length) {
    let low = offset + 1;
    let high = serialized.length;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = chunkLine(
        originalEvent,
        timestamp,
        level,
        component,
        chunkId,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        serialized.slice(offset, middle),
        correlation,
      );
      if (Buffer.byteLength(candidate, 'utf8') <= maximumBytes) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    pieces.push(serialized.slice(offset, best));
    offset = best;
  }

  return pieces.map((content, index) =>
    chunkLine(
      originalEvent,
      timestamp,
      level,
      component,
      chunkId,
      index + 1,
      pieces.length,
      content,
      correlation,
    ),
  );
}

function chunkLine(
  originalEvent: string,
  timestamp: string,
  level: HarnessLogLevel,
  component: string,
  chunkId: string,
  chunkIndex: number,
  chunkCount: number,
  content: string,
  correlation: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...correlation,
    timestamp,
    level,
    component,
    event: 'log.chunk',
    originalEvent,
    chunkId,
    chunkIndex,
    chunkCount,
    encoding: 'json-fragment',
    content,
  });
}

function agentEventLevel(event: AgentEvent): HarnessLogLevel {
  if (event.type === 'error') return 'error';
  if (event.type === 'warning') return 'warn';
  if (event.type === 'tool.completed' && event.result.isError) return 'error';
  return 'info';
}

function agentEventCorrelation(event: AgentEvent): Record<string, unknown> {
  const turnId = 'turnId' in event ? event.turnId : undefined;
  const toolCallId =
    event.type === 'tool.requested' || event.type === 'tool.started'
      ? event.call.id
      : event.type === 'tool.completed'
        ? event.result.toolCallId
        : event.type === 'tool.progress' || event.type === 'permission.requested'
          ? event.toolCallId
          : undefined;
  return {
    ...(turnId === undefined ? {} : { turnId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

function correlationFields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of [
    'invocationId',
    'requestId',
    'runtimeSessionId',
    'traceId',
    'sessionId',
    'turnId',
    'toolCallId',
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
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

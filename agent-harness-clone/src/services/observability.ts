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
      const lines = logLines(
        serialized,
        entry.event,
        timestamp,
        entry.level ?? 'info',
        this.maxLineBytes,
        this.component,
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
            message: error instanceof Error ? error.message : String(error),
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

let chunkSequence = 0;

function logLines(
  serialized: string,
  originalEvent: string,
  timestamp: string,
  level: HarnessLogLevel,
  maximumBytes: number,
  component: string,
): string[] {
  if (Buffer.byteLength(serialized, 'utf8') <= maximumBytes) return [serialized];

  const chunkId = String(Date.now()) + '-' + String(++chunkSequence);
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
): string {
  return JSON.stringify({
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
  if (event.type === 'mcp.server.failed') return 'error';
  if (event.type === 'mcp.tool.call.completed' && event.isError) return 'error';
  if (event.type === 'invocation.completed' && event.status === 'error') return 'error';
  return 'info';
}

function agentEventCorrelation(event: AgentEvent): Record<string, unknown> {
  const turnId = 'turnId' in event ? event.turnId : undefined;
  const toolCallId =
    event.type === 'tool.requested' || event.type === 'tool.started'
      ? event.call.id
      : event.type === 'tool.completed'
        ? event.result.toolCallId
        : event.type === 'tool.progress' ||
            event.type === 'permission.requested' ||
            event.type === 'mcp.tool.call.started' ||
            event.type === 'mcp.tool.call.completed'
          ? event.toolCallId
          : undefined;
  return {
    ...(turnId === undefined ? {} : { turnId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

/**
 * How much of the event stream reaches the log.
 *
 * - `silent`: nothing.
 * - `error`: failures only — `error`, `mcp.server.failed`, failed tool results.
 * - `info`: the shape of the run. Every boundary (invocation, MCP, model, tool,
 *   turn, permission), with tool inputs and results in full. The default.
 * - `debug`: `info` plus completed assistant messages and compaction detail.
 * - `trace`: everything, including per-token `assistant.text.delta`. Very loud;
 *   intended for reproducing a specific failure, not for standing traffic.
 */
export type LogLevel = 'silent' | 'error' | 'info' | 'debug' | 'trace';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** The lowest level at which each event is emitted. */
const EVENT_LEVEL: Partial<Record<AgentEvent['type'], LogLevel>> = {
  error: 'error',
  'mcp.server.failed': 'error',
  'assistant.text.delta': 'trace',
  'assistant.message.completed': 'debug',
  'context.compaction.started': 'debug',
  'context.compaction.completed': 'debug',
  'tool.progress': 'debug',
};

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (trimmed in LEVEL_ORDER) return trimmed as LogLevel;
  throw new Error(`Invalid log level: ${value}. Expected ${Object.keys(LEVEL_ORDER).join(', ')}.`);
}

export type JsonLogSinkOptions = {
  level?: LogLevel;
  /**
   * Defaults to stdout, keeping container output as a single JSON-lines stream.
   */
  write?: (line: string) => void;
  /** Merged into every line — `requestId`, `agentName`, and similar run-wide keys. */
  context?: Record<string, unknown>;
  service?: string;
  /** Caps each string inside a logged payload. Unset logs values in full. */
  maxStringLength?: number;
};

/**
 * One line of JSON per event, on stdout, with credentials removed.
 *
 * Line-delimited JSON because that is what CloudWatch Logs Insights parses without a
 * custom pattern: `fields @timestamp, type, tool.name | filter sessionId = '…'` works
 * against this directly. A multi-line or pretty-printed object would arrive as
 * several unrelated log events and lose that.
 *
 * Every value passes through `redact` (`src/services/redact.ts`) on the way out, so a
 * payload's `apiKey` and an MCP `Authorization` header are blanked before they reach
 * the log. Failures here are swallowed: a sink that throws must not fail a run.
 */
export class JsonLogSink implements EventSink {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;
  private readonly context: Record<string, unknown>;
  private readonly service: string;
  private readonly maxStringLength: number | undefined;

  constructor(options: JsonLogSinkOptions = {}) {
    this.level = options.level ?? 'info';
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.context = options.context ?? {};
    this.service = options.service ?? 'agent-harness';
    this.maxStringLength = options.maxStringLength;
  }

  onEvent(event: AgentEvent): void {
    if (!this.enabled(event)) return;
    try {
      this.write(JSON.stringify(this.line(event)));
    } catch {
      // Observability is never an execution dependency.
    }
  }

  private enabled(event: AgentEvent): boolean {
    const required = EVENT_LEVEL[event.type] ?? 'info';
    return LEVEL_ORDER[this.level] >= LEVEL_ORDER[required];
  }

  private line(event: AgentEvent): Record<string, unknown> {
    const { type, timestamp, sessionId, sequence, protocolVersion, ...rest } = event;
    return {
      timestamp,
      level: this.severity(event),
      service: this.service,
      type,
      sessionId,
      sequence,
      protocolVersion,
      ...this.context,
      ...(redact(rest, {
        ...(this.maxStringLength === undefined ? {} : { maxStringLength: this.maxStringLength }),
      }) as Record<string, unknown>),
    };
  }

  private severity(event: AgentEvent): 'ERROR' | 'WARN' | 'INFO' {
    if (event.type === 'error' || event.type === 'mcp.server.failed') return 'ERROR';
    if (event.type === 'warning') return 'WARN';
    if (event.type === 'tool.completed' && event.result.isError) return 'ERROR';
    if (event.type === 'mcp.tool.call.completed' && event.isError) return 'ERROR';
    if (event.type === 'invocation.completed' && event.status === 'error') return 'ERROR';
    return 'INFO';
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

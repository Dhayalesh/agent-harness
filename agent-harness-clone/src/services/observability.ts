import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/events.js';
import { REDACTED, redact } from './redact.js';

export const REDACTED_LOG_VALUE = REDACTED;

export type HarnessLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly HarnessLogLevel[] = ['debug', 'info', 'warn', 'error'];
const LOG_LEVEL_PRIORITY: Readonly<Record<HarnessLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Parses configuration without silently accepting a misspelled severity. */
export function parseLogLevel(
  value: string | undefined,
  fallback: HarnessLogLevel = 'info',
): HarnessLogLevel {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as HarnessLogLevel;
  }
  throw new Error(
    `Invalid log level ${JSON.stringify(value)}; expected one of: ${LOG_LEVELS.join(', ')}`,
  );
}

export type LogContext = {
  invocationId?: string;
  requestId?: string;
  runtimeSessionId?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  modelRequestId?: string;
  mcpRequestId?: string;
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
  /** Lowest severity written by this sink. Agent event deltas are debug records. */
  minimumLevel?: HarnessLogLevel;
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
  private readonly minimumLevel: HarnessLogLevel;
  private readonly maxLineBytes: number;
  private readonly clock: () => Date;
  private readonly fallbackWrite: (line: string) => void;
  private logSequence = 0;

  constructor(
    private readonly write: (line: string) => void = (line) => process.stderr.write(line + '\n'),
    options: StructuredLogSinkOptions = {},
  ) {
    this.context = options.context ?? {};
    this.component = options.component ?? 'agent-harness';
    this.minimumLevel = parseLogLevel(options.minimumLevel);
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
      const level = logEntryLevel(entry);
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minimumLevel]) return;

      const timestamp = entry.timestamp ?? this.clock().toISOString();
      const event = entry.event;
      const source = { ...this.context, ...entry };
      const outcome = logOutcome(event, level, source);
      const record = redact({
        timestamp,
        level,
        category: logCategory(event),
        event,
        message: logMessage(event, source),
        outcome,
        component: this.component,
        schemaVersion: 1,
        logSequence: this.nextLogSequence(),
        ...correlationFields(source),
        ...detailFields(source),
      });
      const serialized = safeSerialize(record);
      const correlation = correlationFields(record);
      const lines = logLines(
        serialized,
        this.maxLineBytes,
        logEnvelope(record, {
          timestamp,
          level,
          category: logCategory(event),
          event,
          message: logMessage(event, source),
          outcome,
          component: this.component,
          schemaVersion: 1,
          logSequence: this.logSequence,
        }),
        correlation,
      );
      for (const line of lines) this.write(line);
    } catch (error) {
      try {
        this.fallbackWrite(
          JSON.stringify({
            timestamp: this.clock().toISOString(),
            level: 'error',
            category: 'observability',
            event: 'observability.write.failed',
            message: 'Structured log writer failed',
            outcome: 'failure',
            component: this.component,
            schemaVersion: 1,
            logSequence: this.nextLogSequence(),
            errorName: error instanceof Error ? error.name : 'Error',
          }),
        );
      } catch {
        // There is deliberately no third logging dependency.
      }
    }
  }

  private nextLogSequence(): number {
    this.logSequence += 1;
    return this.logSequence;
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

type RequiredLogEnvelope = {
  timestamp: string;
  level: HarnessLogLevel;
  category: string;
  event: string;
  message: string;
  outcome: string;
  component: string;
  schemaVersion: number;
  logSequence: number;
};

function logEnvelope(value: unknown, fallback: RequiredLogEnvelope): RequiredLogEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const source = value as Record<string, unknown>;
  return {
    timestamp: typeof source.timestamp === 'string' ? source.timestamp : fallback.timestamp,
    level: LOG_LEVELS.includes(source.level as HarnessLogLevel)
      ? (source.level as HarnessLogLevel)
      : fallback.level,
    category: typeof source.category === 'string' ? source.category : fallback.category,
    event: typeof source.event === 'string' ? source.event : fallback.event,
    message: typeof source.message === 'string' ? source.message : fallback.message,
    outcome: typeof source.outcome === 'string' ? source.outcome : fallback.outcome,
    component: typeof source.component === 'string' ? source.component : fallback.component,
    schemaVersion:
      typeof source.schemaVersion === 'number' ? source.schemaVersion : fallback.schemaVersion,
    logSequence: typeof source.logSequence === 'number' ? source.logSequence : fallback.logSequence,
  };
}

function logLines(
  serialized: string,
  maximumBytes: number,
  envelope: RequiredLogEnvelope,
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
        envelope,
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
    chunkLine(envelope, chunkId, index + 1, pieces.length, content, correlation),
  );
}

function chunkLine(
  envelope: RequiredLogEnvelope,
  chunkId: string,
  chunkIndex: number,
  chunkCount: number,
  content: string,
  correlation: Record<string, unknown>,
): string {
  return JSON.stringify({
    timestamp: envelope.timestamp,
    level: envelope.level,
    category: 'observability',
    event: 'log.chunk',
    message: `Log chunk ${chunkIndex} of ${chunkCount} for ${envelope.event}`,
    outcome: 'chunked',
    component: envelope.component,
    schemaVersion: envelope.schemaVersion,
    logSequence: envelope.logSequence,
    ...correlation,
    originalEvent: envelope.event,
    originalCategory: envelope.category,
    originalMessage: envelope.message,
    originalOutcome: envelope.outcome,
    chunkId,
    chunkIndex,
    chunkCount,
    encoding: 'json-fragment',
    content,
  });
}

function logEntryLevel(entry: HarnessLogEntry): HarnessLogLevel {
  const explicit = parseLogLevel(entry.level);
  const classified = agentEventEntryLevel(entry);
  if (classified === undefined) return explicit;
  if (classified === 'error') return 'error';
  if (classified === 'warn') {
    return LOG_LEVEL_PRIORITY[explicit] > LOG_LEVEL_PRIORITY.warn ? explicit : 'warn';
  }
  if (classified === 'debug') {
    return explicit === 'warn' || explicit === 'error' ? explicit : 'debug';
  }
  return explicit;
}

function agentEventEntryLevel(entry: HarnessLogEntry): HarnessLogLevel | undefined {
  const payload = eventPayload(entry);
  switch (entry.event) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warn';
    case 'assistant.text.delta':
    case 'assistant.reasoning.delta':
    case 'tool.input.delta':
    case 'tool.requested':
    case 'tool.progress':
    case 'run.preparing':
    case 'assistant.message.completed':
    case 'usage.updated':
      return 'debug';
    case 'tool.started':
      return isRecord(entry.call) || isRecord(payload?.call) ? 'debug' : undefined;
    case 'tool.completed': {
      const result = isRecord(entry.result)
        ? entry.result
        : isRecord(payload?.result)
          ? payload.result
          : undefined;
      if (result === undefined || typeof result.isError !== 'boolean') return undefined;
      return result.isError ? 'error' : 'debug';
    }
    default:
      return undefined;
  }
}

const ENVELOPE_FIELDS = new Set([
  'timestamp',
  'level',
  'category',
  'event',
  'message',
  'outcome',
  'component',
  'schemaVersion',
  'logSequence',
]);

const CORRELATION_FIELDS = [
  'invocationId',
  'requestId',
  'runtimeSessionId',
  'traceId',
  'sessionId',
  'turnId',
  'toolCallId',
  'modelRequestId',
  'mcpRequestId',
] as const;

const CORRELATION_FIELD_SET = new Set<string>(CORRELATION_FIELDS);

function detailFields(source: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (ENVELOPE_FIELDS.has(key) || CORRELATION_FIELD_SET.has(key)) {
      if (key === 'message' && value !== undefined && typeof value !== 'string') {
        details.messageData = value;
      } else if (key === 'message' && typeof value === 'string' && value.trim().length > 320) {
        details.messageDetail = value;
      }
      continue;
    }
    details[key] = value;
  }
  return details;
}

function logCategory(event: string): string {
  const [category] = event.toLowerCase().split('.');
  return category || 'general';
}

function logOutcome(
  event: string,
  level: HarnessLogLevel,
  source: Record<string, unknown>,
): string {
  if (typeof source.outcome === 'string' && source.outcome.trim() !== '') {
    return source.outcome;
  }

  const payload = eventPayload(source);
  const result = isRecord(source.result)
    ? source.result
    : isRecord(payload?.result)
      ? payload.result
      : undefined;
  const status = stringField(source, payload, 'status')?.toLowerCase();
  const reason = stringField(source, payload, 'reason')?.toLowerCase();
  const decision = stringField(source, payload, 'decision')?.toLowerCase();
  const remoteError = source.remoteError === true || payload?.remoteError === true;
  const statusCode = numberField(source, payload, 'statusCode');

  if (
    level === 'error' ||
    result?.isError === true ||
    remoteError ||
    status === 'error' ||
    status === 'failed' ||
    status === 'failure' ||
    reason === 'model_error' ||
    reason === 'budget_exceeded' ||
    (statusCode !== undefined && statusCode >= 400)
  ) {
    return 'failure';
  }
  if (status === 'success' || status === 'succeeded' || status === 'ok') return 'success';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (reason === 'cancelled' || reason === 'canceled') return 'cancelled';
  if (decision === 'allow') return 'allowed';
  if (decision === 'deny') return 'denied';
  if (event === 'error' || event.endsWith('.failed')) return 'failure';
  if (event === 'warning' || event.endsWith('.warning')) return 'warning';
  if (event.endsWith('.cancelled')) return 'cancelled';
  if (event.endsWith('.disconnected')) return 'disconnected';
  if (event.endsWith('.rejected')) return 'rejected';
  if (event.endsWith('.started')) return 'started';
  if (event.endsWith('.completed')) return 'success';
  if (event.endsWith('.validated') || event.endsWith('.ready')) return 'success';
  if (event.endsWith('.requested')) return 'requested';
  if (event.endsWith('.preparing') || event.endsWith('.progress')) return 'in_progress';
  if (event.endsWith('.scheduled')) return 'scheduled';
  if (event.endsWith('.resolved')) return 'resolved';
  if (event.endsWith('.updated')) return 'updated';
  return level === 'warn' ? 'warning' : 'observed';
}

function logMessage(event: string, source: Record<string, unknown>): string {
  const payload = eventPayload(source);
  const suppliedMessage = stringField(source, payload, 'message');
  if (suppliedMessage?.trim()) return concise(suppliedMessage.trim());

  const base = humanizeEvent(event);
  const error = isRecord(source.error)
    ? source.error
    : isRecord(payload?.error)
      ? payload.error
      : undefined;
  const errorMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  if (errorMessage) return concise(`${base}: ${errorMessage}`);

  const reason = stringField(source, payload, 'reason');
  if (event.endsWith('.rejected') && reason) return concise(`${base}: ${reason}`);

  const entity = messageEntity(event, source, payload);
  return entity === undefined ? base : concise(`${base}: ${entity}`);
}

function messageEntity(
  event: string,
  source: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (event.startsWith('tool.')) {
    const call = isRecord(source.call)
      ? source.call
      : isRecord(payload?.call)
        ? payload.call
        : undefined;
    return (
      stringField(source, payload, 'toolName') ??
      (typeof call?.name === 'string' ? call.name : undefined)
    );
  }
  if (event.startsWith('mcp.request.')) {
    const operation = stringField(source, payload, 'operation');
    const serverName = stringField(source, payload, 'serverName');
    if (operation && serverName) return `${operation} on ${serverName}`;
    return operation ?? serverName;
  }
  if (event.startsWith('mcp.')) return stringField(source, payload, 'serverName');
  if (event.startsWith('model.')) {
    return stringField(source, payload, 'model') ?? stringField(source, payload, 'provider');
  }
  if (event.startsWith('agent.')) return stringField(source, payload, 'agentName');
  if (event.startsWith('skill.')) {
    return stringField(source, payload, 'skillName') ?? stringField(source, payload, 'name');
  }
  return undefined;
}

function humanizeEvent(event: string): string {
  const words = event.split(/[._]/).filter(Boolean);
  if (words.length === 0) return 'Log event';
  const acronyms: Readonly<Record<string, string>> = {
    api: 'API',
    aws: 'AWS',
    cloudwatch: 'CloudWatch',
    http: 'HTTP',
    mcp: 'MCP',
  };
  const first = acronyms[words[0]!.toLowerCase()] ?? capitalize(words[0]!);
  return [first, ...words.slice(1).map((word) => acronyms[word.toLowerCase()] ?? word)].join(' ');
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function concise(value: string, maximumLength = 320): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 1)}…`;
}

function eventPayload(source: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isRecord(source.data)) return undefined;
  return source.data.type === source.event ? source.data : undefined;
}

function stringField(
  source: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const value = source[field] ?? payload?.[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(
  source: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
  field: string,
): number | undefined {
  const value = source[field] ?? payload?.[field];
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function agentEventLevel(event: AgentEvent): HarnessLogLevel {
  if (event.type === 'error') return 'error';
  if (event.type === 'warning') return 'warn';
  if (
    event.type === 'assistant.text.delta' ||
    event.type === 'assistant.reasoning.delta' ||
    event.type === 'tool.input.delta' ||
    event.type === 'tool.progress' ||
    event.type === 'assistant.message.completed' ||
    event.type === 'usage.updated' ||
    event.type === 'tool.started'
  ) {
    return 'debug';
  }
  if (event.type === 'tool.completed' && event.result.isError) return 'error';
  if (event.type === 'tool.completed') return 'debug';
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
  for (const key of CORRELATION_FIELDS) {
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

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  type InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * Writes the harness log to a log group this deployment owns, one stream per session.
 *
 * AgentCore names its own streams — `.../[runtime-logs]<uuid>`, one per runtime
 * session — and an application inside the container cannot rename or merge them. That
 * is why a hundred invocations produce a hundred streams no matter what the process
 * writes. Writing directly to a group of our own is the way to choose the layout, and
 * the layout worth choosing is the one that matches how a run is read back: a session
 * is the unit an operator follows, so a session is a stream.
 *
 * Plugged in as the `write` callback of `StructuredLogSink`, so redaction, oversized
 * line chunking, and fail-open behaviour all still happen upstream of this and are
 * not restated here. What this adds is routing, batching, and retry.
 *
 * Three properties this must hold, because it sits underneath every invocation:
 *
 * - It never blocks. `LogSink.log` is synchronous and called on the hot path, so
 *   lines are queued and flushed by a timer rather than awaited.
 * - It never grows without bound. CloudWatch can be slow, throttled, or unreachable;
 *   a queue that answered that by growing would trade a logging outage for an OOM.
 * - It never throws into the caller. A logging failure is reported to the fallback
 *   and counted, and the invocation continues.
 */

/** CloudWatch's own limits. Batches are bounded by these, not by preference. */
const MAX_BATCH_EVENTS = 10_000;
const MAX_BATCH_BYTES = 1_000_000;
const EVENT_OVERHEAD_BYTES = 26;
/** A single event above this is rejected outright by the API. */
const MAX_EVENT_BYTES = 256 * 1024;

export type CloudWatchLogWriterOptions = {
  logGroupName: string;
  /**
   * Region for the client. Falls back to the SDK's own resolution — `AWS_REGION`,
   * then the shared config — which is what the task role already provides in a
   * deployed container.
   */
  region?: string;
  client?: CloudWatchLogsClient;
  /**
   * How a line becomes a stream name. Defaults to the session id, which is the
   * grouping this exists to provide.
   */
  streamNameFor?: (record: Record<string, unknown>) => string;
  /** Flush cadence. Lower means fresher logs and more `PutLogEvents` calls. */
  flushIntervalMs?: number;
  /**
   * Lines held per stream before the oldest are dropped. Reached only when
   * CloudWatch is failing or throttling; a drop is counted and reported rather than
   * silently swallowed, because a gap an operator cannot see is worse than one they
   * can.
   */
  maxQueuedEvents?: number;
  maxRetries?: number;
  /** Receives this writer's own failures. Never the writer itself. */
  fallbackWrite?: (line: string) => void;
  clock?: () => Date;
};

type Stream = {
  name: string;
  queue: InputLogEvent[];
  /** Set once the stream exists, so creation is attempted once per stream. */
  ready: Promise<void> | undefined;
  flushing: boolean;
  dropped: number;
};

export class CloudWatchLogWriter {
  private readonly client: CloudWatchLogsClient;
  private readonly logGroupName: string;
  private readonly streamNameFor: (record: Record<string, unknown>) => string;
  private readonly flushIntervalMs: number;
  private readonly maxQueuedEvents: number;
  private readonly maxRetries: number;
  private readonly fallbackWrite: (line: string) => void;
  private readonly clock: () => Date;

  private readonly streams = new Map<string, Stream>();
  private timer: NodeJS.Timeout | undefined;
  private groupReady: Promise<void> | undefined;
  private closed = false;

  constructor(options: CloudWatchLogWriterOptions) {
    this.logGroupName = options.logGroupName;
    this.client =
      options.client ??
      new CloudWatchLogsClient(options.region === undefined ? {} : { region: options.region });
    this.streamNameFor = options.streamNameFor ?? defaultStreamName;
    this.flushIntervalMs = Math.max(200, options.flushIntervalMs ?? 2_000);
    this.maxQueuedEvents = Math.max(100, options.maxQueuedEvents ?? 10_000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 5);
    this.fallbackWrite = options.fallbackWrite ?? ((line) => process.stderr.write(`${line}\n`));
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * The `write` callback to hand to `StructuredLogSink`.
   *
   * Bound, so it can be passed as a bare function reference without losing `this`.
   */
  readonly write = (line: string): void => {
    if (this.closed) return;
    try {
      this.enqueue(line);
    } catch {
      // Never throws into the invocation that produced the line.
    }
  };

  private enqueue(line: string): void {
    // The line is already serialized JSON. It is parsed only to find the session
    // that routes it; the original string is what gets sent, so nothing is
    // re-serialized and no redaction decision is revisited here.
    let record: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON line still deserves a home; `defaultStreamName` will name it.
    }

    if (Buffer.byteLength(line, 'utf8') + EVENT_OVERHEAD_BYTES > MAX_EVENT_BYTES) {
      // Upstream chunking keeps lines under this, so arriving here means a limit
      // changed or a caller bypassed the sink. Reported rather than sent, because
      // an oversized event fails the whole batch it travels in.
      this.report('cloudwatch.event.oversized', { bytes: Buffer.byteLength(line, 'utf8') });
      return;
    }

    const stream = this.streamFor(this.streamNameFor(record));
    stream.queue.push({ timestamp: this.timestampOf(record), message: line });

    if (stream.queue.length > this.maxQueuedEvents) {
      // Oldest first: during an outage the newest lines describe what is happening
      // now, which is what an operator is looking at.
      const overflow = stream.queue.length - this.maxQueuedEvents;
      stream.queue.splice(0, overflow);
      stream.dropped += overflow;
    }

    this.schedule();
  }

  /**
   * CloudWatch orders and retains by event timestamp, so it is taken from the
   * record's own `timestamp` where present. Falling back to now would reorder a
   * batch that was queued during a stall.
   */
  private timestampOf(record: Record<string, unknown>): number {
    const value = record.timestamp;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return this.clock().getTime();
  }

  private streamFor(name: string): Stream {
    const existing = this.streams.get(name);
    if (existing) return existing;
    const created: Stream = {
      name,
      queue: [],
      ready: undefined,
      flushing: false,
      dropped: 0,
    };
    this.streams.set(name, created);
    return created;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    // Does not hold the process open: a container should be able to exit on an idle
    // timer, and `close()` is what guarantees the last batch is sent.
    this.timer.unref?.();
  }

  /** Sends what is queued. Safe to call at any time; `close` awaits it. */
  async flush(): Promise<void> {
    const streams = [...this.streams.values()].filter(
      (stream) => stream.queue.length > 0 && !stream.flushing,
    );
    await Promise.all(streams.map((stream) => this.flushStream(stream)));
    // A stream that filled again while this ran keeps the timer alive.
    if ([...this.streams.values()].some((stream) => stream.queue.length > 0)) this.schedule();
  }

  private async flushStream(stream: Stream): Promise<void> {
    stream.flushing = true;
    try {
      await this.ensureStream(stream);
      while (stream.queue.length > 0) {
        const batch = takeBatch(stream.queue);
        if (batch.length === 0) break;
        await this.putWithRetry(stream, batch);
      }
      if (stream.dropped > 0) {
        const dropped = stream.dropped;
        stream.dropped = 0;
        this.report('cloudwatch.events.dropped', { stream: stream.name, dropped });
      }
    } catch (error) {
      this.report('cloudwatch.flush.failed', {
        stream: stream.name,
        error: describe(error),
      });
    } finally {
      stream.flushing = false;
    }
  }

  /**
   * `PutLogEvents` no longer needs a sequence token, so a batch is one call. What is
   * retried is throttling and transient failure, with backoff; a permanent error
   * (bad name, missing permission) fails fast rather than spinning.
   */
  private async putWithRetry(stream: Stream, events: InputLogEvent[]): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.send(
          new PutLogEventsCommand({
            logGroupName: this.logGroupName,
            logStreamName: stream.name,
            logEvents: events,
          }),
        );
        return;
      } catch (error) {
        if (attempt >= this.maxRetries || !isRetryable(error)) throw error;
        await delay(Math.min(30_000, 2 ** attempt * 250) + Math.random() * 250);
      }
    }
  }

  /**
   * Creates the group and the stream, once each.
   *
   * `AlreadyExists` is success: several containers write to one group, and two
   * invocations of one session race to create its stream.
   */
  private async ensureStream(stream: Stream): Promise<void> {
    this.groupReady ??= this.createGroup();
    await this.groupReady;
    stream.ready ??= this.createStream(stream.name);
    try {
      await stream.ready;
    } catch (error) {
      // Cleared so a transient failure is retried on the next flush rather than
      // poisoning the stream for the life of the process.
      stream.ready = undefined;
      throw error;
    }
  }

  private async createGroup(): Promise<void> {
    try {
      await this.client.send(new CreateLogGroupCommand({ logGroupName: this.logGroupName }));
    } catch (error) {
      if (!isAlreadyExists(error)) {
        this.groupReady = undefined;
        throw error;
      }
    }
  }

  private async createStream(name: string): Promise<void> {
    try {
      await this.client.send(
        new CreateLogStreamCommand({
          logGroupName: this.logGroupName,
          logStreamName: name,
        }),
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  /** Flushes what is queued and stops the timer. Call on shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  /**
   * This writer's own failures go to the fallback, never back through itself: a
   * CloudWatch outage reported via CloudWatch would be silent exactly when it matters.
   */
  private report(event: string, fields: Record<string, unknown>): void {
    try {
      this.fallbackWrite(
        JSON.stringify({
          timestamp: this.clock().toISOString(),
          level: 'error',
          component: 'agent-harness',
          event,
          ...fields,
        }),
      );
    } catch {
      // There is deliberately no third logging dependency.
    }
  }
}

/**
 * One stream per session, which is the grouping an operator reads by.
 *
 * Prefixed with the date so streams sort chronologically in the console, matching the
 * `YYYY/MM/DD/...` convention AgentCore itself uses. A line with no session — which
 * should only be process-level startup and shutdown — lands in `no-session`, so it is
 * findable rather than dropped.
 */
function defaultStreamName(record: Record<string, unknown>): string {
  const sessionId = record.sessionId ?? record.runtimeSessionId;
  const name = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'no-session';
  const timestamp =
    typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
  const date = new Date(Number.isNaN(timestamp) ? Date.now() : timestamp);
  const day = date.toISOString().slice(0, 10).replace(/-/g, '/');
  return `${day}/${sanitizeStreamName(name)}`;
}

/** `:` and `*` are rejected by CloudWatch; everything else is allowed. */
function sanitizeStreamName(value: string): string {
  return value.replace(/[:*]/g, '_').slice(0, 480);
}

/**
 * Fills one batch from the front of the queue, respecting both CloudWatch limits.
 * Events are removed only as they are taken, so a failed send leaves the remainder
 * queued for the next attempt.
 */
function takeBatch(queue: InputLogEvent[]): InputLogEvent[] {
  const batch: InputLogEvent[] = [];
  let bytes = 0;
  while (queue.length > 0 && batch.length < MAX_BATCH_EVENTS) {
    const next = queue[0];
    if (next === undefined) break;
    const size = Buffer.byteLength(next.message ?? '', 'utf8') + EVENT_OVERHEAD_BYTES;
    if (bytes + size > MAX_BATCH_BYTES && batch.length > 0) break;
    queue.shift();
    batch.push(next);
    bytes += size;
  }
  // CloudWatch requires a batch in ascending timestamp order.
  batch.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  return batch;
}

function isAlreadyExists(error: unknown): boolean {
  return name(error) === 'ResourceAlreadyExistsException';
}

function isRetryable(error: unknown): boolean {
  const errorName = name(error);
  if (
    errorName === 'ThrottlingException' ||
    errorName === 'ServiceUnavailableException' ||
    errorName === 'InternalFailure' ||
    errorName === 'LimitExceededException'
  ) {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status !== undefined && (status === 429 || status >= 500);
}

function name(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deliberately not `unref`ed, unlike the idle flush timer.
 *
 * This one is awaited by an in-flight retry, so letting the process exit during it
 * would abandon a batch mid-flush — losing exactly the lines a shutdown is trying to
 * get out. The flush timer is `unref`ed because nothing is waiting on it; a backoff
 * has a caller.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

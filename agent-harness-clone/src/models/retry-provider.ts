import { AgentAbortError, errorMessage } from '../core/errors.js';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from './provider.js';

export type RetryProviderOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  /** Structured lifecycle records for every upstream attempt and retry. */
  logSink?: LogSink;
  /** Correlation fields copied onto every structured lifecycle record. */
  logContext?: LogContext;
};

export class RetryModelProvider implements ModelProvider {
  readonly name: string;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly logSink: LogSink | undefined;
  private readonly logContext: LogContext;

  constructor(
    private readonly provider: ModelProvider,
    options: RetryProviderOptions = {},
  ) {
    this.name = `retry(${provider.name})`;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 250;
    this.maximumDelayMs = options.maximumDelayMs ?? 4_000;
    this.isRetryable = options.isRetryable ?? defaultRetryable;
    this.logSink = options.logSink;
    this.logContext = options.logContext ?? {};
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const requestContext = {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
      ...(request.modelRequestId === undefined ? {} : { modelRequestId: request.modelRequestId }),
    };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = Date.now();
      let emitted = false;
      emitLog(this.logSink, {
        ...this.logContext,
        ...requestContext,
        event: 'model.attempt.started',
        provider: this.provider.name,
        attempt,
        maxAttempts: this.maxAttempts,
      });
      try {
        for await (const event of this.provider.stream(request)) {
          emitted = true;
          yield event;
        }
        emitLog(this.logSink, {
          ...this.logContext,
          ...requestContext,
          event: 'model.attempt.completed',
          provider: this.provider.name,
          attempt,
          maxAttempts: this.maxAttempts,
          durationMs: Date.now() - started,
        });
        return;
      } catch (error) {
        const retryable =
          !emitted &&
          attempt < this.maxAttempts &&
          !request.signal.aborted &&
          this.isRetryable(error);
        emitLog(this.logSink, {
          ...this.logContext,
          ...requestContext,
          level: retryable ? 'warn' : 'error',
          event: 'model.attempt.failed',
          provider: this.provider.name,
          attempt,
          maxAttempts: this.maxAttempts,
          emitted,
          retryable,
          durationMs: Date.now() - started,
          error: describeError(error),
        });
        if (!retryable) {
          throw error;
        }
        const delay = Math.min(this.maximumDelayMs, this.initialDelayMs * 2 ** (attempt - 1));
        emitLog(this.logSink, {
          ...this.logContext,
          ...requestContext,
          level: 'warn',
          event: 'model.retry.scheduled',
          provider: this.provider.name,
          attempt,
          nextAttempt: attempt + 1,
          delayMs: delay,
        });
        // Also on the stream, not only in the log: a caller watching a backoff has
        // no other way to tell a retry apart from a hang.
        yield {
          type: 'warning',
          code: 'MODEL_RETRY',
          message:
            `${this.provider.name} attempt ${attempt} of ${this.maxAttempts} failed ` +
            `(${errorMessage(error)}); retrying in ${delay}ms`,
        };
        await abortableDelay(delay, request.signal);
      }
    }
  }
}

function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

function defaultRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = 'status' in error ? Number(error.status) : undefined;
  return status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500;
}

function abortableDelay(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AgentAbortError());
      return;
    }
    const timer = setTimeout(resolve, delay);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AgentAbortError());
      },
      { once: true },
    );
  });
}

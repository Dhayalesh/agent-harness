import { AgentAbortError } from '../core/errors.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from './provider.js';

export type RetryProviderOptions = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
};

export class RetryModelProvider implements ModelProvider {
  readonly name: string;
  private readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maximumDelayMs: number;
  private readonly isRetryable: (error: unknown) => boolean;

  constructor(
    private readonly provider: ModelProvider,
    options: RetryProviderOptions = {},
  ) {
    this.name = `retry(${provider.name})`;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 250;
    this.maximumDelayMs = options.maximumDelayMs ?? 4_000;
    this.isRetryable = options.isRetryable ?? defaultRetryable;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let emitted = false;
      try {
        for await (const event of this.provider.stream(request)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (
          emitted ||
          attempt === this.maxAttempts ||
          request.signal.aborted ||
          !this.isRetryable(error)
        ) {
          throw error;
        }
        const delay = Math.min(this.maximumDelayMs, this.initialDelayMs * 2 ** (attempt - 1));
        await abortableDelay(delay, request.signal);
      }
    }
  }
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

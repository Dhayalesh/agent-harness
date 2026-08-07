/**
 * A single-consumer queue that lets a callback feed an async generator.
 *
 * The session reports its work by yielding; a running tool reports its own by
 * calling a plain callback. Without something between them the callback has
 * nowhere to put an event until the generator is next resumed — which, for a tool
 * the session is awaiting, is only after that tool has already finished. The
 * progress then arrives as history rather than as progress, which is the
 * difference between watching a command run and reading its transcript.
 */
export class AsyncEventQueue<T> {
  private readonly buffered: T[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  /** Ignored after `close`, so a tool that leaks its callback cannot emit late. */
  push(value: T): void {
    if (this.closed) return;
    this.buffered.push(value);
    this.release();
  }

  /** Ends `drain` once the values already queued have been delivered. */
  close(): void {
    this.closed = true;
    this.release();
  }

  /**
   * Yields until `close`. One consumer only: a second would race the first for
   * values rather than see the same ones.
   */
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buffered.length > 0) {
        yield this.buffered.shift() as T;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

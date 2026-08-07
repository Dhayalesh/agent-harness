import { AgentHarnessError } from '../core/errors.js';
import type { AgentSession } from '../core/agent-session.js';
import type { AgentEvent } from '../core/events.js';

/**
 * Live runs, kept only for as long as something might still need them.
 *
 * This is the state the stateless server deliberately does not have, so it is
 * opt-in and scoped to the two things that cannot work without it:
 *
 * - **Resuming.** A dropped connection loses a turn that may have minutes of work
 *   in it. Replaying needs the events to still exist, which needs the run to
 *   outlive the socket that asked for it.
 * - **Answering a permission request.** `permissionFallback: 'ask'` suspends the
 *   run until someone decides. That someone is a second HTTP request, which can
 *   only reach the session if a reference to it was kept.
 *
 * Both cost the property that any replica can serve any request: a reconnect or a
 * decision has to reach the process holding the run. Under AgentCore that already
 * holds — a runtime session id is pinned to one container — which is why this is
 * safe there and why it stays off by default anywhere else.
 */

export type RunRegistryOptions = {
  /**
   * Events kept per run. A reader that has fallen further behind than this is
   * told so rather than silently resumed from a gap.
   */
  maxBufferedEvents?: number;
  /**
   * How long a run with no reader survives before it is aborted and dropped.
   * Spans both the reconnect window and the idle life of a finished run.
   */
  resumeWindowMs?: number;
};

/**
 * Opens the run. Receives the setter for the session so a control channel can
 * reach it once it exists.
 */
export type RunFactory = (
  setSession: (session: AgentSession) => void,
) => AsyncGenerator<AgentEvent>;

export class ResumeWindowExpiredError extends AgentHarnessError {
  constructor(message: string) {
    super(message, 'RESUME_WINDOW_EXPIRED');
  }
}

class RunRecord {
  session: AgentSession | undefined;
  private readonly iterator: AsyncGenerator<AgentEvent>;
  private readonly events: AgentEvent[] = [];
  /** Sequence of `events[0]`; rises as the buffer is trimmed. */
  private firstSequence = 1;
  private finished = false;
  private failure: unknown;
  private wake: (() => void) | undefined;
  private readers = 0;
  private expiry: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    open: RunFactory,
    private readonly maxBufferedEvents: number,
    private readonly resumeWindowMs: number,
    private readonly onDrop: (id: string) => void,
  ) {
    // The factory is handed the setter rather than the record: the run has to be
    // opened here, and its session does not exist until several awaits later.
    this.iterator = open((session) => {
      this.session = session;
    });
    void this.consume();
    // Armed from the start: a caller that never reads is the same problem as one
    // that stops reading, and neither should keep an MCP server alive.
    this.armExpiry();
  }

  /**
   * Consumes the run independently of anyone reading it. That independence is the
   * point: the work continues across a reconnect instead of being cancelled by a
   * socket closing.
   */
  private async consume(): Promise<void> {
    try {
      for await (const event of this.iterator) {
        this.append(event);
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.finished = true;
      this.release();
    }
  }

  private append(event: AgentEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxBufferedEvents) {
      this.events.shift();
      this.firstSequence += 1;
    }
    this.release();
  }

  /** Yields everything after `afterSequence`, then everything that follows. */
  async *read(afterSequence: number): AsyncGenerator<AgentEvent> {
    this.readers += 1;
    this.clearExpiry();
    try {
      if (afterSequence > 0 && afterSequence + 1 < this.firstSequence) {
        throw new ResumeWindowExpiredError(
          `Run ${this.id} has already discarded events after ${afterSequence}; ` +
            `the earliest still held is ${this.firstSequence}. Start a new run.`,
        );
      }
      let cursor = afterSequence;
      for (;;) {
        while (true) {
          const index = cursor + 1 - this.firstSequence;
          const event = index >= 0 ? this.events[index] : undefined;
          if (!event) break;
          cursor = event.sequence;
          yield event;
        }
        if (this.finished) {
          if (this.failure !== undefined) throw this.failure;
          return;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      this.readers -= 1;
      if (this.readers === 0) this.armExpiry();
    }
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private armExpiry(): void {
    this.clearExpiry();
    this.expiry = setTimeout(() => {
      void this.abort();
    }, this.resumeWindowMs);
    // Never the reason a process stays alive.
    this.expiry.unref?.();
  }

  private clearExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
  }

  /**
   * Ends the run and drops it. Returning into the generator is what reaches its
   * `finally`, which closes the MCP connections and deletes the skill directory.
   */
  async abort(): Promise<void> {
    this.clearExpiry();
    this.onDrop(this.id);
    this.finished = true;
    this.release();
    await this.iterator.return(undefined as never).catch(() => undefined);
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly maxBufferedEvents: number;
  private readonly resumeWindowMs: number;

  constructor(options: RunRegistryOptions = {}) {
    this.maxBufferedEvents = options.maxBufferedEvents ?? 2_000;
    this.resumeWindowMs = options.resumeWindowMs ?? 60_000;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** Starts a run under `id`, or throws if one is already there. */
  start(id: string, open: RunFactory): RunRecord {
    if (this.runs.has(id)) {
      throw new AgentHarnessError(`Run ${id} is already in flight`, 'RUN_ALREADY_ACTIVE');
    }
    const record = new RunRecord(id, open, this.maxBufferedEvents, this.resumeWindowMs, (dropped) =>
      this.runs.delete(dropped),
    );
    this.runs.set(id, record);
    return record;
  }

  /** Ends every run. Called on shutdown so no MCP process outlives the server. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.abort()));
    this.runs.clear();
  }
}

export type { RunRecord };

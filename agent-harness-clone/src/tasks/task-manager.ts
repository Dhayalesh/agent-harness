import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/events.js';
import type { AgentSession } from '../core/agent-session.js';
import type { RuntimeHost } from '../runtime/runtime-host.js';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskKind = 'shell' | 'agent';

export type TaskRecord = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  description: string;
  createdAt: string;
  updatedAt: string;
  output: string;
  error?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};

export type StartShellTask = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};

export type StartAgentTask = {
  prompt: string;
  description?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
};

type InternalTask = {
  record: TaskRecord;
  controller: AbortController;
  completion: Promise<TaskRecord>;
};

export type TaskManagerOptions = {
  runtime: RuntimeHost;
  createSubagent?: () => AgentSession | Promise<AgentSession>;
  maxConcurrent?: number;
  maxOutputBytes?: number;
};

export class TaskManager {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly listeners = new Set<(task: TaskRecord) => void>();
  private readonly maxConcurrent: number;
  private readonly maxOutputBytes: number;

  constructor(private readonly options: TaskManagerOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxOutputBytes = options.maxOutputBytes ?? 2_000_000;
  }

  startShell(input: StartShellTask): TaskRecord {
    this.assertCapacity();
    const task = this.createTask('shell', input.description ?? input.command, input);
    task.completion = this.runShell(task, input);
    return clone(task.record);
  }

  startAgent(input: StartAgentTask): TaskRecord {
    this.assertCapacity();
    if (!this.options.createSubagent) throw new Error('No subagent factory is configured');
    const task = this.createTask('agent', input.description ?? input.prompt, input);
    task.completion = this.runAgent(task, input);
    return clone(task.record);
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? clone(task.record) : undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map((task) => clone(task.record));
  }

  async wait(id: string): Promise<TaskRecord> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return clone(await task.completion);
  }

  stop(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.record.status !== 'running') return false;
    task.controller.abort('task stopped');
    return true;
  }

  async stopAll(): Promise<void> {
    const running = [...this.tasks.values()].filter((task) => task.record.status === 'running');
    for (const task of running) task.controller.abort('task manager closing');
    await Promise.allSettled(running.map((task) => task.completion));
  }

  subscribe(listener: (task: TaskRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private createTask(
    kind: TaskKind,
    description: string,
    parent: { parentSessionId?: string; parentToolCallId?: string },
  ): InternalTask {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      kind,
      status: 'running',
      description,
      createdAt: now,
      updatedAt: now,
      output: '',
      ...(parent.parentSessionId === undefined ? {} : { parentSessionId: parent.parentSessionId }),
      ...(parent.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: parent.parentToolCallId }),
    };
    const task: InternalTask = {
      record,
      controller: new AbortController(),
      completion: Promise.resolve(record),
    };
    this.tasks.set(record.id, task);
    this.notify(record);
    return task;
  }

  private async runShell(task: InternalTask, input: StartShellTask): Promise<TaskRecord> {
    try {
      const result = await this.options.runtime.execute(input.command, {
        signal: task.controller.signal,
        maxOutputBytes: this.maxOutputBytes,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        onOutput: (stream, chunk) => this.append(task, `${stream}: ${chunk}`),
      });
      this.append(task, `\nexit_code: ${String(result.exitCode)}\n`);
      this.finish(task, result.exitCode === 0 ? 'completed' : 'failed');
    } catch (error) {
      this.finish(
        task,
        task.controller.signal.aborted ? 'cancelled' : 'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    return task.record;
  }

  private async runAgent(task: InternalTask, input: StartAgentTask): Promise<TaskRecord> {
    let session: AgentSession | undefined;
    try {
      session = await this.options.createSubagent?.();
      if (!session) throw new Error('Subagent factory returned no session');
      const abort = (): void => session?.interrupt('parent task stopped');
      task.controller.signal.addEventListener('abort', abort, { once: true });
      for await (const event of session.run({ prompt: input.prompt })) {
        this.appendAgentEvent(task, event);
      }
      await session.close();
      this.finish(task, task.controller.signal.aborted ? 'cancelled' : 'completed');
    } catch (error) {
      await session?.close().catch(() => undefined);
      this.finish(
        task,
        task.controller.signal.aborted ? 'cancelled' : 'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    return task.record;
  }

  private appendAgentEvent(task: InternalTask, event: AgentEvent): void {
    if (event.type === 'assistant.text.delta') this.append(task, event.delta);
    if (event.type === 'tool.completed' && event.result.isError) {
      this.append(task, `\n[tool error] ${event.result.content}\n`);
    }
  }

  private append(task: InternalTask, content: string): void {
    const current = task.record.output;
    const available = Math.max(0, this.maxOutputBytes - Buffer.byteLength(current));
    if (available > 0) {
      task.record.output += Buffer.from(content).subarray(0, available).toString('utf8');
    }
    task.record.updatedAt = new Date().toISOString();
    this.notify(task.record);
  }

  private finish(task: InternalTask, status: TaskStatus, error?: string): void {
    task.record.status = status;
    task.record.updatedAt = new Date().toISOString();
    if (error !== undefined) task.record.error = error;
    this.notify(task.record);
  }

  private assertCapacity(): void {
    const running = [...this.tasks.values()].filter(
      (task) => task.record.status === 'running',
    ).length;
    if (running >= this.maxConcurrent) {
      throw new Error(`Task concurrency limit reached (${this.maxConcurrent})`);
    }
  }

  private notify(record: TaskRecord): void {
    for (const listener of this.listeners) listener(clone(record));
  }
}

function clone(record: TaskRecord): TaskRecord {
  return structuredClone(record);
}

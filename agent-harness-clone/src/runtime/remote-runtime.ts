import { randomUUID } from 'node:crypto';
import type { MessageChannel } from '../transports/message-channel.js';
import type {
  RuntimeDirectoryEntry,
  RuntimeExecOptions,
  RuntimeExecResult,
  RuntimeFileStat,
  RuntimeHost,
} from './runtime-host.js';

type RuntimeOperation =
  | { type: 'resolvePath'; path: string; allowMissing: boolean }
  | { type: 'readText'; path: string }
  | { type: 'writeText'; path: string; content: string }
  | { type: 'stat'; path: string }
  | { type: 'readDirectory'; path: string }
  | {
      type: 'execute';
      command: string;
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };

export type RuntimeRpcMessage =
  | { kind: 'request'; id: string; operation: RuntimeOperation }
  | { kind: 'cancel'; id: string }
  | { kind: 'response'; id: string; value?: unknown; error?: string }
  | { kind: 'progress'; id: string; stream: 'stdout' | 'stderr'; chunk: string };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (stream: 'stdout' | 'stderr', chunk: string) => void;
};

export class RemoteRuntimeHost implements RuntimeHost {
  readonly kind = 'remote-rpc';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly channel: MessageChannel<RuntimeRpcMessage>,
    readonly rootDirectory: string,
  ) {
    this.unsubscribe = channel.subscribe((message) => this.onMessage(message));
  }

  async resolvePath(path: string, allowMissing = false): Promise<string> {
    return this.request({ type: 'resolvePath', path, allowMissing });
  }

  async readText(path: string): Promise<string> {
    return this.request({ type: 'readText', path });
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.request({ type: 'writeText', path, content });
  }

  async stat(path: string): Promise<RuntimeFileStat> {
    return this.request({ type: 'stat', path });
  }

  async readDirectory(path: string): Promise<RuntimeDirectoryEntry[]> {
    return this.request({ type: 'readDirectory', path });
  }

  async execute(command: string, options: RuntimeExecOptions): Promise<RuntimeExecResult> {
    return this.request(
      {
        type: 'execute',
        command,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      },
      options.signal,
      options.onOutput,
    );
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const pending of this.pending.values()) pending.reject(new Error('Remote runtime closed'));
    this.pending.clear();
    await this.channel.close();
  }

  private request<T>(
    operation: RuntimeOperation,
    signal?: AbortSignal,
    onProgress?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  ): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Remote runtime request aborted'));
        return;
      }
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      signal?.addEventListener(
        'abort',
        () => {
          void this.channel.send({ kind: 'cancel', id });
          const pending = this.pending.get(id);
          this.pending.delete(id);
          pending?.reject(new Error('Remote runtime request aborted'));
        },
        { once: true },
      );
      void this.channel.send({ kind: 'request', id, operation });
    });
  }

  private onMessage(message: RuntimeRpcMessage): void {
    if (message.kind === 'progress') {
      this.pending.get(message.id)?.onProgress?.(message.stream, message.chunk);
      return;
    }
    if (message.kind !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.value);
  }
}

export class RuntimeRpcServer {
  private readonly controllers = new Map<string, AbortController>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly channel: MessageChannel<RuntimeRpcMessage>,
    private readonly runtime: RuntimeHost,
  ) {
    this.unsubscribe = channel.subscribe((message) => void this.onMessage(message));
  }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const controller of this.controllers.values()) controller.abort('RPC server closing');
    this.controllers.clear();
    await this.channel.close();
  }

  private async onMessage(message: RuntimeRpcMessage): Promise<void> {
    if (message.kind === 'cancel') {
      this.controllers.get(message.id)?.abort('remote cancellation');
      return;
    }
    if (message.kind !== 'request') return;
    const controller = new AbortController();
    this.controllers.set(message.id, controller);
    try {
      const value = await this.execute(message.id, message.operation, controller.signal);
      await this.channel.send({ kind: 'response', id: message.id, value });
    } catch (error) {
      await this.channel.send({
        kind: 'response',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.controllers.delete(message.id);
    }
  }

  private execute(id: string, operation: RuntimeOperation, signal: AbortSignal): Promise<unknown> {
    switch (operation.type) {
      case 'resolvePath':
        return this.runtime.resolvePath(operation.path, operation.allowMissing);
      case 'readText':
        return this.runtime.readText(operation.path);
      case 'writeText':
        return this.runtime.writeText(operation.path, operation.content);
      case 'stat':
        return this.runtime.stat(operation.path);
      case 'readDirectory':
        return this.runtime.readDirectory(operation.path);
      case 'execute':
        return this.runtime.execute(operation.command, {
          signal,
          ...(operation.cwd === undefined ? {} : { cwd: operation.cwd }),
          ...(operation.timeoutMs === undefined ? {} : { timeoutMs: operation.timeoutMs }),
          ...(operation.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: operation.maxOutputBytes }),
          onOutput: (stream, chunk) => {
            void this.channel.send({ kind: 'progress', id, stream, chunk });
          },
        });
    }
  }
}

export interface MessageChannel<T = unknown> {
  send(message: T): void | Promise<void>;
  subscribe(listener: (message: T) => void): () => void;
  close(): void | Promise<void>;
}

export function createInMemoryChannelPair<T>(): [MessageChannel<T>, MessageChannel<T>] {
  const leftListeners = new Set<(message: T) => void>();
  const rightListeners = new Set<(message: T) => void>();
  let closed = false;

  const side = (
    own: Set<(message: T) => void>,
    remote: Set<(message: T) => void>,
  ): MessageChannel<T> => ({
    send(message) {
      if (closed) throw new Error('Message channel is closed');
      const copied = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of remote) listener(copied);
      });
    },
    subscribe(listener) {
      own.add(listener);
      return () => own.delete(listener);
    },
    close() {
      closed = true;
      leftListeners.clear();
      rightListeners.clear();
    },
  });

  return [side(leftListeners, rightListeners), side(rightListeners, leftListeners)];
}

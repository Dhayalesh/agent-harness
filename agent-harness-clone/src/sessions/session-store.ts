import type { AgentMessage } from '../core/messages.js';
import { AgentHarnessError } from '../core/errors.js';

export const PREPARED_CONTEXT_MAX_MESSAGES = 1_000;
export const PREPARED_CONTEXT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A provider-ready prefix prepared from the first `sourceMessageCount` canonical
 * messages. New canonical messages are appended as a tail when the session resumes.
 */
export type PreparedContextCheckpoint = {
  version: 1;
  sourceMessageCount: number;
  /** Detects a rewritten canonical prefix; normal session history is append-only. */
  sourceLastMessageId?: string;
  messages: AgentMessage[];
};

export type StoredSession = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  /** Prepared model context; canonical history always remains in `messages`. */
  preparedContext?: PreparedContextCheckpoint;
  metadata: Record<string, unknown>;
};

export type SessionStoreOptions = {
  /** Expire inactive sessions after this many milliseconds. Zero disables expiry. */
  ttlMs?: number;
  /** Maximum serialized size of one session. Defaults to 10 MiB. */
  maxBytes?: number;
};

export interface SessionStore {
  readonly kind?: 'memory' | 'file' | 's3' | 'custom';
  load(id: string): Promise<StoredSession | undefined>;
  save(session: StoredSession): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>>;
}

export class InMemorySessionStore implements SessionStore {
  readonly kind = 'memory' as const;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(private readonly options: SessionStoreOptions = {}) {}

  async load(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    if (session && isExpired(session, this.options.ttlMs)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session ? validateStoredSession(structuredClone(session)) : undefined;
  }

  async save(session: StoredSession): Promise<void> {
    assertSessionSize(session, this.options.maxBytes);
    this.sessions.set(session.id, structuredClone(session));
  }

  async delete(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async list(): Promise<Array<Pick<StoredSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>>> {
    for (const [id, session] of this.sessions) {
      if (isExpired(session, this.options.ttlMs)) this.sessions.delete(id);
    }
    return [...this.sessions.values()].map(({ id, createdAt, updatedAt, metadata }) => ({
      id,
      createdAt,
      updatedAt,
      metadata: structuredClone(metadata),
    }));
  }
}

export function isExpired(session: StoredSession, ttlMs = 0, now = Date.now()): boolean {
  if (ttlMs <= 0) return false;
  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt + ttlMs <= now;
}

export function assertSessionSize(session: StoredSession, maximum = 10 * 1024 * 1024): void {
  const bytes = Buffer.byteLength(JSON.stringify(session), 'utf8');
  if (bytes > maximum) {
    throw new AgentHarnessError(
      `Session ${session.id} is ${bytes} bytes; maximum is ${maximum}`,
      'SESSION_TOO_LARGE',
    );
  }
}

export function validateStoredSession(value: unknown): StoredSession {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string' ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string' ||
    !('messages' in value) ||
    !Array.isArray(value.messages) ||
    !('metadata' in value) ||
    typeof value.metadata !== 'object' ||
    value.metadata === null ||
    Array.isArray(value.metadata)
  ) {
    throw new AgentHarnessError('Stored session is invalid', 'INVALID_STORED_SESSION');
  }
  const session = value as StoredSession & {
    preparedContext?: unknown;
    /** Legacy derived state is accepted only so old canonical sessions still load. */
    contextIntelligence?: unknown;
  };
  const preparedContext = validatePreparedContextCheckpoint(
    session.preparedContext,
    session.messages,
  );
  const {
    preparedContext: _untrustedPrepared,
    contextIntelligence: _legacyContextIntelligence,
    ...canonical
  } = session;
  return {
    ...canonical,
    ...(preparedContext === undefined ? {} : { preparedContext }),
  };
}

export function createPreparedContextCheckpoint(
  messages: readonly AgentMessage[],
  canonicalMessages: readonly AgentMessage[],
): PreparedContextCheckpoint | undefined {
  const sourceMessageCount = canonicalMessages.length;
  const checkpoint: PreparedContextCheckpoint = {
    version: 1,
    sourceMessageCount,
    ...(sourceMessageCount === 0
      ? {}
      : { sourceLastMessageId: canonicalMessages[sourceMessageCount - 1]!.id }),
    messages: structuredClone([...messages]),
  };
  return validatePreparedContextCheckpoint(checkpoint, canonicalMessages);
}

export function validatePreparedContextCheckpoint(
  value: unknown,
  canonicalMessages: readonly AgentMessage[],
): PreparedContextCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<PreparedContextCheckpoint>;
  const sourceCount = candidate.sourceMessageCount;
  if (
    candidate.version !== 1 ||
    !Number.isInteger(sourceCount) ||
    sourceCount === undefined ||
    sourceCount < 0 ||
    sourceCount > canonicalMessages.length ||
    (sourceCount > 0 && candidate.sourceLastMessageId !== canonicalMessages[sourceCount - 1]?.id) ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length > PREPARED_CONTEXT_MAX_MESSAGES ||
    !candidate.messages.every(isAgentMessage)
  ) {
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PREPARED_CONTEXT_MAX_BYTES) {
    return undefined;
  }
  if (!hasCompleteToolPairs(candidate.messages)) return undefined;
  return structuredClone(candidate as PreparedContextCheckpoint);
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<AgentMessage>;
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.createdAt === 'string' &&
    (message.reasoning === undefined || typeof message.reasoning === 'string') &&
    Array.isArray(message.content) &&
    message.content.every((block) => {
      if (!block || typeof block !== 'object' || !('type' in block)) return false;
      switch (block.type) {
        case 'text':
          return 'text' in block && typeof block.text === 'string';
        case 'tool_call':
          return (
            'id' in block &&
            typeof block.id === 'string' &&
            'name' in block &&
            typeof block.name === 'string' &&
            'input' in block
          );
        case 'tool_result':
          return (
            'toolCallId' in block &&
            typeof block.toolCallId === 'string' &&
            'content' in block &&
            typeof block.content === 'string' &&
            'isError' in block &&
            typeof block.isError === 'boolean'
          );
        case 'image':
          return (
            'mediaType' in block &&
            typeof block.mediaType === 'string' &&
            'data' in block &&
            typeof block.data === 'string' &&
            (!('filename' in block) ||
              block.filename === undefined ||
              typeof block.filename === 'string')
          );
        default:
          return false;
      }
    })
  );
}

function hasCompleteToolPairs(messages: readonly AgentMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') calls.add(block.id);
      if (block.type === 'tool_result') results.add(block.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id)) && [...results].every((id) => calls.has(id));
}

import { createHash } from 'node:crypto';
import type { AgentMessage, ToolCallBlock, ToolResultBlock } from '../core/messages.js';

/** The bounded vocabulary exposed by deterministic context preparation. */
export type ContextItemType =
  | 'user_request'
  | 'conversation'
  | 'task_state'
  | 'tool_observation'
  | 'retrieved_content'
  | 'file_content'
  | 'artifact_content'
  | 'system_context'
  | 'execution_state';

export type ContextItemPriority = 'critical' | 'high' | 'normal' | 'low';

export type ContextItemSource =
  | { kind: 'system'; id: 'system-prompt' }
  | { kind: 'message'; id: string; role: AgentMessage['role'] }
  | { kind: 'tool'; name: string; toolCallId: string; resultMessageId: string };

/**
 * Canonical lineage for one projected item. Tool lineage identifies the exact model
 * call and canonical result; when context management bounds the visible observation,
 * a canonical hash and transformation replace an unbounded duplicate of its content.
 * A planned call without a result can therefore never become evidence.
 */
export type ContextProvenance = {
  sourceMessageId?: string;
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
  toolResult?: {
    messageId: string;
    toolCallId: string;
    /** Content actually included in the bounded model input. */
    content: string;
    isError: boolean;
    metadata?: Record<string, unknown>;
    /** Present when context management changed the canonical observation. */
    transformation?: 'truncated' | 'deduplicated';
    /** Hash and size identify the canonical observation without copying it unbounded. */
    originalContentHash?: string;
    originalContentCharacters?: number;
  };
};

export type ContextItem = {
  id: string;
  type: ContextItemType;
  content: string;
  source: ContextItemSource;
  timestamp: string;
  relevance: number;
  priority: ContextItemPriority;
  provenance: ContextProvenance;
  estimatedTokens: number;
};

export type ContextProjectionRequest = {
  messages: readonly AgentMessage[];
  /**
   * Canonical history from which the prepared messages were selected or transformed.
   * Omitted when `messages` itself is canonical.
   */
  canonicalMessages?: readonly AgentMessage[];
  /** Identity of the user request that remains current across its tool turns. */
  currentRequestId?: string;
  /** Kept separate from messages and projected only for inspection/budgeting. */
  systemPrompt?: string;
};

type PreparedProjectionTarget = {
  messages: readonly AgentMessage[];
};

/** Projects the exact final model messages without changing their order or budget. */
export function finalizePreparedContext<T extends PreparedProjectionTarget>(
  request: ContextProjectionRequest,
  prepared: T,
): T & { items: readonly ContextItem[] } {
  return {
    ...prepared,
    items: projectContextItems({
      ...request,
      messages: prepared.messages,
      canonicalMessages: request.canonicalMessages ?? request.messages,
    }),
  };
}

/** Produces a deterministic, content-bounded projection of final prepared input. */
export function projectContextItems(request: ContextProjectionRequest): readonly ContextItem[] {
  const items: ContextItem[] = [];
  const fallbackTimestamp =
    (request.currentRequestId
      ? request.messages.find((message) => message.id === request.currentRequestId)?.createdAt
      : undefined) ??
    request.messages.at(-1)?.createdAt ??
    '1970-01-01T00:00:00.000Z';

  if (request.systemPrompt) {
    items.push(
      item({
        type: 'system_context',
        content: request.systemPrompt,
        source: { kind: 'system', id: 'system-prompt' },
        timestamp: fallbackTimestamp,
        relevance: 1,
        priority: 'critical',
        provenance: {},
      }),
    );
  }

  const canonicalMessages = request.canonicalMessages ?? request.messages;
  const canonicalCalls = new Map<string, ToolCallBlock>();
  const canonicalResults = new Map<string, ToolResultBlock>();
  for (const message of canonicalMessages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') canonicalCalls.set(block.id, block);
      if (block.type === 'tool_result') {
        canonicalResults.set(resultKey(message.id, block.toolCallId), block);
      }
    }
  }

  const visibleCalls = new Map<string, ToolCallBlock>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') visibleCalls.set(block.id, block);
    }
  }

  for (const message of request.messages) {
    const text = messageText(message);
    if (text !== '') {
      const isCurrentRequest = message.id === request.currentRequestId;
      const isTaskState = !isCurrentRequest && isTaskStateText(text);
      items.push(
        item({
          type: isCurrentRequest ? 'user_request' : isTaskState ? 'task_state' : 'conversation',
          content: text,
          source: { kind: 'message', id: message.id, role: message.role },
          timestamp: message.createdAt,
          relevance: isCurrentRequest ? 1 : isTaskState ? 0.9 : 0.7,
          priority: isCurrentRequest ? 'critical' : isTaskState ? 'high' : 'normal',
          provenance: { sourceMessageId: message.id },
        }),
      );
    }

    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const visibleCall = visibleCalls.get(block.toolCallId);
      // A result without its model-visible call cannot provide tool evidence.
      if (!visibleCall) continue;
      const call = canonicalCalls.get(block.toolCallId) ?? visibleCall;
      const canonicalResult =
        canonicalResults.get(resultKey(message.id, block.toolCallId)) ?? block;
      const transformation = observationTransformation(block, canonicalResult);
      // A duplicate pointer describes context management, not the successful
      // observation that was removed. A bounded excerpt remains evidence, but its
      // provenance explicitly identifies the transformation and canonical hash.
      const type =
        transformation === 'deduplicated'
          ? 'execution_state'
          : toolResultType(call, canonicalResult);
      items.push(
        item({
          type,
          content: block.content,
          source: {
            kind: 'tool',
            name: call.name,
            toolCallId: call.id,
            resultMessageId: message.id,
          },
          timestamp: message.createdAt,
          relevance: canonicalResult.isError || transformation === 'deduplicated' ? 0.5 : 0.85,
          priority:
            canonicalResult.isError || transformation === 'deduplicated'
              ? 'normal'
              : type === 'task_state'
                ? 'high'
                : 'normal',
          provenance: {
            sourceMessageId: message.id,
            toolCall: {
              id: call.id,
              name: call.name,
              input: structuredClone(call.input),
            },
            toolResult: {
              messageId: message.id,
              toolCallId: block.toolCallId,
              content: block.content,
              isError: canonicalResult.isError,
              ...(canonicalResult.metadata === undefined
                ? {}
                : { metadata: structuredClone(canonicalResult.metadata) }),
              ...(transformation === undefined
                ? {}
                : {
                    transformation,
                    originalContentHash: contentHash(canonicalResult.content),
                    originalContentCharacters: canonicalResult.content.length,
                  }),
            },
          },
        }),
      );
    }
  }

  // Identical deterministic items collapse to the newest actual observation.
  const newest = new Map<string, ContextItem>();
  for (const candidate of items) {
    const key = identityKey(candidate);
    const previous = newest.get(key);
    if (!previous || compareTimestamp(previous, candidate) <= 0) newest.set(key, candidate);
  }

  return [...newest.values()].sort((left, right) => {
    const category = orderOf(left.type) - orderOf(right.type);
    if (category !== 0) return category;
    const timestamp = compareTimestamp(left, right);
    return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
  });
}

function resultKey(messageId: string, toolCallId: string): string {
  return `${messageId}:${toolCallId}`;
}

function observationTransformation(
  visible: ToolResultBlock,
  canonical: ToolResultBlock,
): 'truncated' | 'deduplicated' | undefined {
  if (visible.content === canonical.content) return undefined;
  return /^\[Identical to a later result of .+; the duplicate copy was removed to fit the context\./.test(
    visible.content,
  )
    ? 'deduplicated'
    : 'truncated';
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function item(input: Omit<ContextItem, 'id' | 'estimatedTokens'>): ContextItem {
  const key = stableStringify({
    type: input.type,
    content: input.content,
    source:
      input.source.kind === 'tool'
        ? { kind: input.source.kind, name: input.source.name }
        : input.source.kind === 'message'
          ? { kind: input.source.kind, role: input.source.role }
          : input.source,
    toolInput: input.provenance.toolCall?.input,
  });
  return {
    ...input,
    id: `context-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    estimatedTokens: estimateTextTokens(input.content),
  };
}

function messageText(message: AgentMessage): string {
  return message.content
    .flatMap((block) => {
      if (block.type === 'text') return [block.text];
      if (block.type === 'image') return [`[Image: ${block.filename ?? block.mediaType}]`];
      return [];
    })
    .filter(Boolean)
    .join('\n');
}

function isTaskStateText(content: string): boolean {
  return (
    /^\[(?:Context state|Task state)\]/i.test(content) ||
    /^## (?:Task|Current State)\b/im.test(content)
  );
}

function toolResultType(call: ToolCallBlock, result: ToolResultBlock): ContextItemType {
  if (result.isError) return 'execution_state';
  if (call.name === 'todo_write') return 'task_state';
  if (hasArtifact(result) || /^create_.+_artifact$/.test(call.name)) return 'artifact_content';
  if (call.name === 'read_file' || call.name === 'glob' || call.name === 'grep') {
    return 'file_content';
  }
  if (call.name === 'web_search' || call.name === 'web_fetch' || call.name.startsWith('mcp__')) {
    return 'retrieved_content';
  }
  return 'tool_observation';
}

function hasArtifact(result: ToolResultBlock): boolean {
  const artifact = result.metadata?.artifact;
  return typeof artifact === 'object' && artifact !== null;
}

function identityKey(value: ContextItem): string {
  return stableStringify({
    type: value.type,
    content: value.content,
    source:
      value.source.kind === 'tool'
        ? { kind: value.source.kind, name: value.source.name }
        : value.source.kind === 'message'
          ? { kind: value.source.kind, role: value.source.role }
          : value.source,
    toolInput: value.provenance.toolCall?.input,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function estimateTextTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function compareTimestamp(left: ContextItem, right: ContextItem): number {
  const byText = left.timestamp.localeCompare(right.timestamp);
  return byText === 0 ? left.id.localeCompare(right.id) : byText;
}

function orderOf(type: ContextItemType): number {
  switch (type) {
    case 'system_context':
      return 0;
    case 'user_request':
      return 1;
    case 'conversation':
      return 2;
    case 'task_state':
      return 3;
    case 'tool_observation':
      return 4;
    case 'retrieved_content':
    case 'file_content':
    case 'artifact_content':
      return 5;
    case 'execution_state':
      return 6;
  }
}

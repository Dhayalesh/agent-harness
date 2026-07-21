import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '../core/messages.js';

export type PreparedContext = {
  messages: readonly AgentMessage[];
  estimatedTokens: number;
  compacted: boolean;
  tokensBefore?: number;
};

export type ContextRequest = {
  messages: readonly AgentMessage[];
  maxInputTokens?: number;
};

export interface ContextManager {
  prepare(request: ContextRequest): Promise<PreparedContext>;
}

export class PassthroughContextManager implements ContextManager {
  async prepare({ messages }: ContextRequest): Promise<PreparedContext> {
    return {
      messages,
      estimatedTokens: estimateMessagesTokens(messages),
      compacted: false,
    };
  }
}

export type CompactingContextOptions = {
  maxInputTokens?: number;
  retainRecentMessages?: number;
};

export class CompactingContextManager implements ContextManager {
  private readonly maxInputTokens: number;
  private readonly retainRecentMessages: number;

  constructor(options: CompactingContextOptions = {}) {
    this.maxInputTokens = options.maxInputTokens ?? 100_000;
    this.retainRecentMessages = options.retainRecentMessages ?? 8;
  }

  async prepare(request: ContextRequest): Promise<PreparedContext> {
    const limit = request.maxInputTokens ?? this.maxInputTokens;
    const before = estimateMessagesTokens(request.messages);
    if (before <= limit) {
      return { messages: request.messages, estimatedTokens: before, compacted: false };
    }

    let split = Math.max(0, request.messages.length - this.retainRecentMessages);
    while (
      split > 0 &&
      request.messages[split]?.content.some((block) => block.type === 'tool_result')
    ) {
      split -= 1;
    }
    const older = request.messages.slice(0, split);
    const recent = request.messages.slice(split);
    const summary = older
      .map((message) => {
        const content = message.content
          .map((block) => {
            if (block.type === 'text') return block.text;
            if (block.type === 'tool_call') return `[tool ${block.name}]`;
            return `[tool result ${block.toolCallId}: ${block.isError ? 'error' : 'ok'}]`;
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .slice(0, 600);
        return `${message.role}: ${content}`;
      })
      .join('\n');
    const compacted: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `[Compacted earlier conversation]\n${summary.slice(0, Math.max(1_000, limit * 2))}`,
        },
      ],
    };
    const messages = [compacted, ...recent];
    return {
      messages,
      estimatedTokens: estimateMessagesTokens(messages),
      compacted: true,
      tokensBefore: before,
    };
  }
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  const characters = JSON.stringify(messages).length;
  return Math.max(1, Math.ceil(characters / 4));
}

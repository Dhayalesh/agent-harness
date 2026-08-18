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
            // An image cannot survive summarisation into text, so the summary
            // records that one was here rather than pretending to describe it.
            if (block.type === 'image') return `[image ${block.filename ?? block.mediaType}]`;
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

/**
 * What one image costs, in place of its transport size.
 *
 * A vision model bills an image as a few hundred to roughly fifteen hundred tokens
 * depending on how it is tiled. Its base64 payload is nothing like that: a 1 MB
 * screenshot is about 1.4 million characters, which the character heuristic would
 * read as several hundred thousand tokens and compact away every turn. This is a
 * deliberately conservative flat charge instead.
 */
const IMAGE_TOKEN_ESTIMATE = 1_200;

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let images = 0;
  const measurable = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'image') return block;
      images += 1;
      // Everything but the bytes: the name and type still occupy the prompt.
      return { type: block.type, mediaType: block.mediaType, filename: block.filename };
    }),
  }));
  const characters = JSON.stringify(measurable).length;
  return Math.max(1, Math.ceil(characters / 4) + images * IMAGE_TOKEN_ESTIMATE);
}

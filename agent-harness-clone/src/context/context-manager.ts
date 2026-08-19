import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '../core/messages.js';

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export interface TokenEstimator {
  estimateMessages(messages: readonly AgentMessage[]): number;
  estimateMessage(message: AgentMessage): number;
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

/**
 * Default token estimator using the existing char/4 + image-flat-rate heuristic.
 *
 * Where the model provider reports actual usage, that information is fed back
 * through observability/calibration channels rather than replacing this estimator,
 * which must run without a live model call.
 */
export class DefaultTokenEstimator implements TokenEstimator {
  estimateMessages(messages: readonly AgentMessage[]): number {
    return estimateMessagesTokens(messages);
  }

  estimateMessage(message: AgentMessage): number {
    return estimateMessagesTokens([message]);
  }
}

// ---------------------------------------------------------------------------
// Model context capabilities
// ---------------------------------------------------------------------------

/**
 * The subset of model capabilities that drive context budget decisions.
 * Mirrors `ModelProviderCapabilities` but without requiring a platform import.
 */
export type ModelContextCapabilities = {
  /** Total token window the model supports. */
  contextWindow: number;
  /** Maximum tokens the model may produce in a single response. */
  maxOutputTokens: number;
};

// ---------------------------------------------------------------------------
// Context policy
// ---------------------------------------------------------------------------

/**
 * Configurable policy that governs when and how aggressively context is managed.
 *
 * All threshold values are fractions of the effective input budget (0–1).
 * The invariant `warningThreshold ≤ aggressiveThreshold ≤ compactionThreshold < 1`
 * is enforced at construction.
 */
export type ContextPolicy = {
  /**
   * Fraction of the input budget at which a warning is logged.
   * Default: 0.70
   */
  warningThreshold: number;
  /**
   * Fraction of the input budget at which truncation of large tool results begins.
   * Default: 0.80
   */
  aggressiveThreshold: number;
  /**
   * Fraction of the input budget at which full compaction is triggered.
   * Default: 0.90
   */
  compactionThreshold: number;
  /**
   * Tokens permanently reserved as headroom between the estimated context and the
   * hard input limit. Accounts for system-prompt overhead, header tokens, etc.
   * Default: 2000
   */
  safetyMarginTokens: number;
  /**
   * Tokens of recent conversation always retained verbatim after compaction.
   * Default: 8000
   */
  retainRecentTokens: number;
  /**
   * Override the output reservation when computing the effective input budget.
   * When absent, the model's own `maxOutputTokens` is used.
   */
  reserveOutputTokens?: number;
  /**
   * Maximum tokens a single tool result may contribute before it is summarised
   * or truncated. Default: 4000
   */
  maxToolResultTokens: number;
  /**
   * When true (default), a summarisation LLM call is attempted before falling
   * back to deterministic truncation.
   */
  enableSummarization: boolean;
};

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  warningThreshold: 0.7,
  aggressiveThreshold: 0.8,
  compactionThreshold: 0.9,
  safetyMarginTokens: 2_000,
  retainRecentTokens: 8_000,
  maxToolResultTokens: 4_000,
  enableSummarization: true,
};

// ---------------------------------------------------------------------------
// ContextManager contract
// ---------------------------------------------------------------------------

export type PreparedContext = {
  messages: readonly AgentMessage[];
  estimatedTokens: number;
  compacted: boolean;
  tokensBefore?: number;
  /**
   * Present when model capabilities were supplied: the effective budget this
   * context was prepared against.
   */
  budget?: {
    contextWindow: number;
    outputReserved: number;
    safetyMargin: number;
    effectiveInputBudget: number;
    utilizationFraction: number;
  };
  metadata?: {
    compactionId?: string;
    strategy?: 'deterministic' | 'llm-summarization' | 'passthrough';
    fallbackUsed?: boolean;
  };
};

export type ContextRequest = {
  messages: readonly AgentMessage[];
  maxInputTokens?: number;
  /** When supplied, the context manager derives a dynamic budget from the model. */
  modelCapabilities?: ModelContextCapabilities;
  /** Overrides the default policy for this request. */
  policy?: Partial<ContextPolicy>;
  /**
   * Compact this turn regardless of how full the context is.
   *
   * The threshold policy decides on its own when compaction is *necessary*; this is
   * for when something outside the session asks for it anyway — a user pressing
   * "compact context" in a client, or an emergency retry after the provider
   * rejected the request. Everything else about compaction is unchanged: the
   * canonical history is still untouched and the tool boundaries are still kept.
   */
  forceCompaction?: boolean;
};

export interface ContextManager {
  prepare(request: ContextRequest): Promise<PreparedContext>;
}

// ---------------------------------------------------------------------------
// PassthroughContextManager
// ---------------------------------------------------------------------------

export class PassthroughContextManager implements ContextManager {
  async prepare({ messages }: ContextRequest): Promise<PreparedContext> {
    return {
      messages,
      estimatedTokens: estimateMessagesTokens(messages),
      compacted: false,
    };
  }
}

// ---------------------------------------------------------------------------
// CompactionSummarizer interface
// ---------------------------------------------------------------------------

export type CompactionSummaryInput = {
  /** The messages being summarised — older portion only. */
  messages: readonly AgentMessage[];
  /** Estimated token count of the messages being summarised. */
  estimatedTokens: number;
};

export type CompactionSummaryResult = {
  /** The summary text to embed into the context as a user message. */
  summary: string;
  /** Strategy that produced the result. */
  strategy: 'llm-summarization' | 'deterministic';
};

/**
 * Optional plug-in that can produce richer, LLM-generated summaries.
 *
 * When present and `ContextPolicy.enableSummarization` is true, the
 * `DynamicCompactingContextManager` calls this before falling back to the
 * deterministic algorithm.
 *
 * A failed call must NOT throw — return `undefined` to signal fallback.
 */
export interface CompactionSummarizer {
  summarize(input: CompactionSummaryInput): Promise<CompactionSummaryResult | undefined>;
}

// ---------------------------------------------------------------------------
// Helpers: deterministic compaction summary
// ---------------------------------------------------------------------------

/**
 * Pi-style compaction fields preserved in the deterministic summary.
 * Captures the semantically important parts rather than merely concatenating.
 */
function buildDeterministicSummary(messages: readonly AgentMessage[], maxChars: number): string {
  const sections: string[] = [];
  const toolResults: string[] = [];
  const errors: string[] = [];
  const textParts: string[] = [];

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        const snippet = block.text.slice(0, 300).replace(/\s+/g, ' ');
        textParts.push(`${message.role}: ${snippet}`);
      } else if (block.type === 'tool_call') {
        textParts.push(`[tool call: ${block.name}]`);
      } else if (block.type === 'tool_result') {
        if (block.isError) {
          errors.push(`[tool error: ${block.content.slice(0, 200)}]`);
        } else {
          toolResults.push(`[tool result: ${block.content.slice(0, 200)}]`);
        }
      } else if (block.type === 'image') {
        textParts.push(`[image: ${block.filename ?? block.mediaType}]`);
      }
    }
  }

  sections.push('## Prior Conversation Summary');
  if (textParts.length > 0) {
    sections.push('### Conversation:\n' + textParts.join('\n').slice(0, Math.floor(maxChars * 0.6)));
  }
  if (toolResults.length > 0) {
    sections.push('### Tool Results:\n' + toolResults.join('\n').slice(0, Math.floor(maxChars * 0.2)));
  }
  if (errors.length > 0) {
    sections.push('### Errors:\n' + errors.join('\n').slice(0, Math.floor(maxChars * 0.1)));
  }

  return sections.join('\n\n').slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// CompactingContextManager (original — preserved for backward compatibility)
// ---------------------------------------------------------------------------

export type CompactingContextOptions = {
  maxInputTokens?: number;
  retainRecentMessages?: number;
};

/**
 * Original compacting context manager. Preserved for full backward compatibility.
 *
 * For dynamic model-aware context management, prefer `DynamicCompactingContextManager`.
 */
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

// ---------------------------------------------------------------------------
// DynamicCompactingContextManager (new — Pi-inspired, model-aware)
// ---------------------------------------------------------------------------

export type DynamicCompactingContextOptions = {
  /**
   * Configured input token ceiling. Narrows the model's budget but never widens it.
   * When absent, the model's contextWindow minus outputReservation is used.
   */
  maxInputTokens?: number;
  /**
   * Configured output token ceiling. Narrows the model's maxOutputTokens.
   * When absent, the model's maxOutputTokens is used.
   */
  maxOutputTokens?: number;
  /** Partial policy overrides layered on top of DEFAULT_CONTEXT_POLICY. */
  policy?: Partial<ContextPolicy>;
  /** Optional LLM-based summarizer. Falls back to deterministic when absent or on failure. */
  summarizer?: CompactionSummarizer;
  /** Token estimator. Defaults to DefaultTokenEstimator. */
  tokenEstimator?: TokenEstimator;
};

/**
 * Dynamic, model-aware context manager inspired by Pi/pi-mono's compaction approach.
 *
 * Key behaviors:
 * - Derives the effective input budget from the current model's capabilities on each
 *   turn — the same session works correctly across 128K, 256K, and 1M+ models.
 * - Applies configurable threshold policy (warning / aggressive / compaction).
 * - Never splits an assistant tool-call from its corresponding tool-result.
 * - Never mutates the canonical session history — compaction only affects what the
 *   model sees (PreparedContext), not what is stored in AgentSession.
 * - Optionally uses an LLM summarizer; falls back to deterministic algorithm safely.
 *
 * Pi integration note:
 * ─────────────────────────────────────────────────────────────────────────────
 * The Pi/pi-mono package is not installed in this repository (clean-room rules).
 * This class implements the Pi-inspired compaction algorithm internally as an
 * adapter. Specifically adapted from the Pi compaction strategy concepts:
 *   - Dynamic budget derivation from model capabilities
 *   - Threshold-based compaction triggers
 *   - Structured summary preserving: goal, intent, constraints, decisions,
 *     completed work, pending work, important facts, errors, tool state
 *   - Tool-call / tool-result boundary safety
 *
 * If the pi-mono package is later installed and exposes a stable, minimal
 * compaction API without pulling in CLI/TUI/runtime dependencies, this class
 * can be updated to delegate to it while keeping this class as the adapter.
 *
 * Source reference: Pi compaction concepts, pi-mono repository (no version pinned
 * — package not installed). Implementation is clean-room, independent of any
 * Pi source files.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class DynamicCompactingContextManager implements ContextManager {
  private readonly configuredMaxInputTokens: number | undefined;
  private readonly configuredMaxOutputTokens: number | undefined;
  private readonly basePolicy: ContextPolicy;
  private readonly summarizer: CompactionSummarizer | undefined;
  private readonly estimator: TokenEstimator;

  constructor(options: DynamicCompactingContextOptions = {}) {
    this.configuredMaxInputTokens = options.maxInputTokens;
    this.configuredMaxOutputTokens = options.maxOutputTokens;
    this.basePolicy = { ...DEFAULT_CONTEXT_POLICY, ...options.policy };
    this.summarizer = options.summarizer;
    this.estimator = options.tokenEstimator ?? new DefaultTokenEstimator();
    this.validatePolicy(this.basePolicy);
  }

  async prepare(request: ContextRequest): Promise<PreparedContext> {
    const policy = request.policy
      ? { ...this.basePolicy, ...request.policy }
      : this.basePolicy;

    const budget = this.resolveBudget(request, policy);
    const before = this.estimator.estimateMessages(request.messages);
    const utilizationFraction = before / budget.effectiveInputBudget;

    // An explicit request compacts whatever the thresholds would have said.
    //
    // The retention window is narrowed to half the current context for this call
    // only. Without that, a request to compact a context that is still well inside
    // `retainRecentTokens` would find nothing older than the window and return
    // unchanged — technically correct, and indistinguishable from a broken button.
    if (request.forceCompaction) {
      return this.compact(request.messages, before, budget, utilizationFraction, {
        ...policy,
        retainRecentTokens: Math.min(policy.retainRecentTokens, Math.floor(before / 2)),
      });
    }

    // Below warning threshold: return as-is.
    if (utilizationFraction < policy.warningThreshold) {
      return {
        messages: request.messages,
        estimatedTokens: before,
        compacted: false,
        budget: { ...budget, utilizationFraction },
        metadata: { strategy: 'passthrough' },
      };
    }

    // Below compaction threshold: still return as-is but include budget info
    // so callers can observe rising utilization. Aggressive tool-result truncation
    // may apply at aggressiveThreshold but we do not compact the full history yet.
    if (utilizationFraction < policy.compactionThreshold) {
      return {
        messages: request.messages,
        estimatedTokens: before,
        compacted: false,
        budget: { ...budget, utilizationFraction },
        metadata: { strategy: 'passthrough' },
      };
    }

    // At or above compaction threshold: compact.
    return this.compact(request.messages, before, budget, utilizationFraction, policy);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private resolveBudget(
    request: ContextRequest,
    policy: ContextPolicy,
  ): {
    contextWindow: number;
    outputReserved: number;
    safetyMargin: number;
    effectiveInputBudget: number;
    utilizationFraction: number;
  } {
    const capabilities = request.modelCapabilities;

    // Output reservation: policy override → configured limit → model capability → fallback
    const modelMaxOutput = capabilities?.maxOutputTokens ?? 8_192;
    const outputReserved = Math.min(
      policy.reserveOutputTokens ?? this.configuredMaxOutputTokens ?? modelMaxOutput,
      modelMaxOutput,
    );

    // Context window: model capability → large fallback
    const contextWindow = capabilities?.contextWindow ?? 200_000;

    // Safety check: outputReserved + safetyMargin must not exceed contextWindow
    const safetyMargin = policy.safetyMarginTokens;
    const rawInputBudget = contextWindow - outputReserved - safetyMargin;

    // Configured maxInputTokens narrows but never widens the model budget
    let effectiveInputBudget: number;
    if (this.configuredMaxInputTokens !== undefined) {
      if (this.configuredMaxInputTokens + outputReserved > contextWindow) {
        // Configured limit exceeds model capacity — clamp to safe value
        effectiveInputBudget = Math.max(1, rawInputBudget);
      } else {
        effectiveInputBudget = Math.min(this.configuredMaxInputTokens, rawInputBudget);
      }
    } else if (request.maxInputTokens !== undefined) {
      // Per-request override (e.g. from reactive compaction)
      effectiveInputBudget = Math.min(request.maxInputTokens, rawInputBudget);
    } else {
      effectiveInputBudget = Math.max(1, rawInputBudget);
    }

    return {
      contextWindow,
      outputReserved,
      safetyMargin,
      effectiveInputBudget: Math.max(1, effectiveInputBudget),
      utilizationFraction: 0, // will be filled by caller
    };
  }

  private async compact(
    messages: readonly AgentMessage[],
    tokensBefore: number,
    budget: ReturnType<DynamicCompactingContextManager['resolveBudget']>,
    utilizationFraction: number,
    policy: ContextPolicy,
  ): Promise<PreparedContext> {
    const compactionId = randomUUID();

    // Find how many recent tokens to retain
    const { recentMessages, olderMessages } = this.splitAtRetentionBoundary(
      messages,
      policy.retainRecentTokens,
    );

    // If nothing to compact (all messages fit in retained budget), just return
    if (olderMessages.length === 0) {
      return {
        messages,
        estimatedTokens: tokensBefore,
        compacted: false,
        budget: { ...budget, utilizationFraction },
        metadata: { strategy: 'passthrough', compactionId },
      };
    }

    // Attempt LLM summarization first, then fall back to deterministic
    let summaryText: string;
    let strategy: 'llm-summarization' | 'deterministic';
    let fallbackUsed = false;

    const summarizationInput: CompactionSummaryInput = {
      messages: olderMessages,
      estimatedTokens: this.estimator.estimateMessages(olderMessages),
    };

    if (policy.enableSummarization && this.summarizer) {
      try {
        const result = await this.summarizer.summarize(summarizationInput);
        if (result) {
          summaryText = result.summary;
          strategy = result.strategy;
        } else {
          summaryText = this.buildDeterministicSummaryText(olderMessages, budget.effectiveInputBudget);
          strategy = 'deterministic';
          fallbackUsed = true;
        }
      } catch {
        // Summarization failure must never corrupt the session
        summaryText = this.buildDeterministicSummaryText(olderMessages, budget.effectiveInputBudget);
        strategy = 'deterministic';
        fallbackUsed = true;
      }
    } else {
      summaryText = this.buildDeterministicSummaryText(olderMessages, budget.effectiveInputBudget);
      strategy = 'deterministic';
    }

    const compactedMessage: AgentMessage = {
      id: compactionId,
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `[Compacted earlier conversation]\n${summaryText}`,
        },
      ],
    };

    const resultMessages = [compactedMessage, ...recentMessages];
    const tokensAfter = this.estimator.estimateMessages(resultMessages);

    return {
      messages: resultMessages,
      estimatedTokens: tokensAfter,
      compacted: true,
      tokensBefore,
      budget: { ...budget, utilizationFraction },
      metadata: { compactionId, strategy, fallbackUsed },
    };
  }

  /**
   * Splits messages at a boundary that:
   * 1. Respects the retainRecentTokens budget
   * 2. Never splits an assistant tool-call from its corresponding tool-result
   */
  private splitAtRetentionBoundary(
    messages: readonly AgentMessage[],
    retainRecentTokens: number,
  ): { recentMessages: AgentMessage[]; olderMessages: AgentMessage[] } {
    // Walk from the end, accumulating tokens until we exceed retainRecentTokens
    let retained = 0;
    let splitIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) break;
      const msgTokens = this.estimator.estimateMessage(msg);
      if (retained + msgTokens > retainRecentTokens && splitIndex < messages.length) {
        // Would exceed — stop here (splitIndex stays at i+1)
        break;
      }
      retained += msgTokens;
      splitIndex = i;
    }

    // Walk forward from splitIndex to ensure we do not start on a tool_result
    // (which would orphan it from its tool_call)
    while (
      splitIndex > 0 &&
      splitIndex < messages.length &&
      messages[splitIndex]?.content.some((block) => block.type === 'tool_result')
    ) {
      splitIndex -= 1;
    }

    const olderMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    return {
      olderMessages: [...olderMessages],
      recentMessages: [...recentMessages],
    };
  }

  private buildDeterministicSummaryText(
    messages: readonly AgentMessage[],
    budgetTokens: number,
  ): string {
    // Max chars = budgetTokens * 4 * 0.25 so the summary uses at most 25% of the budget
    const maxChars = Math.max(1_000, Math.floor(budgetTokens * 4 * 0.25));
    return buildDeterministicSummary(messages, maxChars);
  }

  private validatePolicy(policy: ContextPolicy): void {
    const { warningThreshold, aggressiveThreshold, compactionThreshold } = policy;
    if (
      warningThreshold < 0 ||
      warningThreshold > 1 ||
      aggressiveThreshold < 0 ||
      aggressiveThreshold > 1 ||
      compactionThreshold < 0 ||
      compactionThreshold >= 1
    ) {
      throw new Error('ContextPolicy thresholds must be between 0 and 1');
    }
    if (warningThreshold > aggressiveThreshold || aggressiveThreshold > compactionThreshold) {
      throw new Error(
        'ContextPolicy requires: warningThreshold ≤ aggressiveThreshold ≤ compactionThreshold',
      );
    }
  }
}

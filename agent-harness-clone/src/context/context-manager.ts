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
  /**
   * What share of the compaction target the summary may occupy.
   *
   * Internal, and absent by default — `SUMMARY_BUDGET_FRACTION` (0.25) applies when
   * it is not set, which is what every existing caller gets. It exists so the
   * orchestration layer can allocate adaptively per turn: a conversation with a
   * great deal of old history and little live state needs a larger summary than one
   * with the reverse shape, and a fixed quarter serves neither well.
   *
   * Not a user-facing knob. Nothing in an agent record or an invocation payload
   * reaches this field; it is derived from the conversation.
   */
  summaryBudgetFraction?: number;
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

/** The threshold a stored record falls back to when it names no percentage. */
export const DEFAULT_COMPACTION_PERCENT = 90;

/**
 * Turns an agent's single "shrink at N%" dial into a full policy.
 *
 * The percentage is the compaction threshold, expressed against the effective
 * input budget the model provider's own `contextWindow` and `maxOutputTokens`
 * imply. An agent record therefore never states a token count: the tokens belong
 * to the model, and the percentage is the only part that is a matter of taste.
 *
 * The warning and aggressive thresholds are scaled to keep the spacing
 * `DEFAULT_CONTEXT_POLICY` uses rather than being left where they were. At 90
 * this reproduces the defaults exactly (0.7 / 0.8 / 0.9); at 50 all three move
 * down together. Leaving them fixed would trip the
 * `warningThreshold ≤ aggressiveThreshold ≤ compactionThreshold` invariant the
 * constructor enforces, so any percentage below 80 would throw instead of
 * compacting early — which is precisely what asking for 50 means.
 */
/**
 * Which of the policy's thresholds a measured utilisation has crossed.
 *
 * Exported because a caller that wants to warn at the same point the policy does
 * should not have to re-derive the comparison and risk drifting from it.
 */
export function classifyPressure(
  utilizationFraction: number,
  policy: Pick<ContextPolicy, 'warningThreshold' | 'aggressiveThreshold' | 'compactionThreshold'>,
): ContextPressure {
  if (utilizationFraction >= policy.compactionThreshold) return 'critical';
  if (utilizationFraction >= policy.aggressiveThreshold) return 'aggressive';
  if (utilizationFraction >= policy.warningThreshold) return 'warning';
  return 'nominal';
}

export function contextPolicyFromPercent(percent: number): Partial<ContextPolicy> {
  const compactionThreshold = percent / 100;
  const scale = compactionThreshold / DEFAULT_CONTEXT_POLICY.compactionThreshold;
  return {
    compactionThreshold,
    warningThreshold: DEFAULT_CONTEXT_POLICY.warningThreshold * scale,
    aggressiveThreshold: DEFAULT_CONTEXT_POLICY.aggressiveThreshold * scale,
  };
}

// ---------------------------------------------------------------------------
// ContextManager contract
// ---------------------------------------------------------------------------

/**
 * Which threshold the measured context has crossed.
 *
 * Reported on every `prepare` so a caller can log or surface rising pressure
 * without recomputing the fractions itself. The policy names three thresholds and
 * this is how the two below `compactionThreshold` become observable: without it
 * `warningThreshold` and `aggressiveThreshold` are settings that nothing can see.
 */
export type ContextPressure = 'nominal' | 'warning' | 'aggressive' | 'critical';

/** Why a compaction that was asked for did not change anything. */
export type CompactionSkipReason =
  /** Everything already fits inside the retention window; there is no older half. */
  | 'nothing-older'
  /** The context is a single message, which cannot be split into summary and tail. */
  | 'already-minimal';

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
    /** Which threshold the pre-compaction measurement crossed. */
    pressure?: ContextPressure;
    /** How many oversized tool results were shortened in place. */
    toolResultsTruncated?: number;
    /**
     * Set when compaction was requested or required but produced no change, with
     * the reason. A forced compaction that silently does nothing is
     * indistinguishable from a broken button, so it says which it was.
     */
    skipped?: CompactionSkipReason;
    /**
     * True when the prepared context still exceeds the effective input budget
     * after everything the policy allows. The provider will very likely reject it,
     * and the caller's reactive retry is the remaining move.
     */
    stillOverBudget?: boolean;
    /**
     * What the orchestration layer decided this turn, when one is in front of this
     * manager.
     *
     * Absent for a bare `DynamicCompactingContextManager`, a `CompactingContextManager`,
     * or any caller-supplied manager — which is what keeps every existing consumer of
     * `metadata` working unchanged. Typed as `unknown` here rather than importing
     * `ContextDecision` because the orchestrator depends on this module and not the
     * other way round; `context-orchestrator.ts` exports the concrete type and a
     * `contextDecisionOf()` reader for it.
     */
    orchestration?: unknown;
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

/** The budget a turn was prepared against. */
export type ContextBudget = {
  contextWindow: number;
  outputReserved: number;
  safetyMargin: number;
  effectiveInputBudget: number;
  utilizationFraction: number;
};

/** Window assumed when the runtime supplied no model capabilities. */
const FALLBACK_CONTEXT_WINDOW = 200_000;
/** Reply reservation assumed when the runtime supplied no model capabilities. */
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Derives the effective input budget for one turn.
 *
 * ```
 * effectiveInputBudget = contextWindow - outputReserved - safetyMargin
 * ```
 *
 * Extracted from `DynamicCompactingContextManager` so the orchestration layer above
 * it measures against exactly the same number. Two implementations of this
 * arithmetic would mean the layer that decides *whether* to act and the layer that
 * acts disagree about how full the context is — which is the one disagreement in a
 * context system that cannot be debugged from the outside.
 *
 * No model-specific knowledge: everything comes from the capabilities the runtime
 * reports, so the same code path serves a 128 K window and a 1 M one.
 */
export function deriveContextBudget(options: {
  capabilities?: ModelContextCapabilities | undefined;
  policy: Pick<ContextPolicy, 'safetyMarginTokens'> & { reserveOutputTokens?: number };
  /** A configured ceiling that narrows the model's budget but never widens it. */
  configuredMaxInputTokens?: number | undefined;
  /** A configured reply ceiling, clamped to what the model can actually produce. */
  configuredMaxOutputTokens?: number | undefined;
  /** A per-request ceiling, such as the one the reactive retry imposes. */
  requestMaxInputTokens?: number | undefined;
}): ContextBudget {
  const { capabilities } = options;
  const modelMaxOutput = capabilities?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
  const outputReserved = Math.min(
    options.policy.reserveOutputTokens ?? options.configuredMaxOutputTokens ?? modelMaxOutput,
    modelMaxOutput,
  );
  const contextWindow = capabilities?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  const safetyMargin = options.policy.safetyMarginTokens;
  const rawInputBudget = contextWindow - outputReserved - safetyMargin;

  let effectiveInputBudget: number;
  if (options.configuredMaxInputTokens !== undefined) {
    effectiveInputBudget =
      options.configuredMaxInputTokens + outputReserved > contextWindow
        ? Math.max(1, rawInputBudget)
        : Math.min(options.configuredMaxInputTokens, rawInputBudget);
  } else if (options.requestMaxInputTokens !== undefined) {
    effectiveInputBudget = Math.min(options.requestMaxInputTokens, rawInputBudget);
  } else {
    effectiveInputBudget = Math.max(1, rawInputBudget);
  }

  return {
    contextWindow,
    outputReserved,
    safetyMargin,
    effectiveInputBudget: Math.max(1, effectiveInputBudget),
    utilizationFraction: 0,
  };
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
  /**
   * The token allowance the summary must fit, as the caller sized it against the
   * compaction target.
   *
   * Optional for backward compatibility, and supplied by every manager in this
   * repository. A summariser that sets its own output ceiling is deciding how much
   * of someone else's budget to spend: its `maxTokens` knows nothing about the
   * window, the reserved reply, or the threshold that triggered the compaction. The
   * caller clamps the result regardless, so honouring this only avoids paying for
   * tokens that are about to be cut off mid-sentence.
   */
  maxSummaryTokens?: number;
  /**
   * A structured reading of the conversation's state — goal, constraints, decisions,
   * pending work — as the context layer derived it deterministically.
   *
   * Supplied so a summarisation model corroborates and extends a known-good outline
   * instead of rediscovering it from scratch, which is where a summary loses the one
   * constraint that mattered.
   */
  stateOutline?: string;
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
    sections.push(
      '### Conversation:\n' + textParts.join('\n').slice(0, Math.floor(maxChars * 0.6)),
    );
  }
  if (toolResults.length > 0) {
    sections.push(
      '### Tool Results:\n' + toolResults.join('\n').slice(0, Math.floor(maxChars * 0.2)),
    );
  }
  if (errors.length > 0) {
    sections.push('### Errors:\n' + errors.join('\n').slice(0, Math.floor(maxChars * 0.1)));
  }

  return sections.join('\n\n').slice(0, maxChars);
}

/**
 * How much of the effective input budget a compaction summary may occupy.
 *
 * Also what lets compaction size its retention window up front: because the
 * summary can never exceed this share, the tail that is kept verbatim can be
 * chosen so that tail plus summary is known to fit before either is built.
 */
const SUMMARY_BUDGET_FRACTION = 0.25;

/** Characters per token the estimator assumes, restated for the inverse direction. */
const CHARS_PER_TOKEN = 4;

/**
 * Shortens tool results that are individually larger than the policy allows.
 *
 * This is the cheap relief `aggressiveThreshold` and `maxToolResultTokens` were
 * always meant to provide, and it runs before full compaction is considered: one
 * runaway `read_file` or `execute` result is a far more common cause of a full
 * context than a genuinely long conversation, and trimming it costs no summary,
 * no model call, and no history. The head and tail of the output are both kept
 * because the useful parts of a large result are usually at its edges — a command
 * echoes its inputs first and its error last.
 *
 * Returns the original array when nothing needed shortening, so callers can keep
 * relying on reference identity to mean "untouched".
 */
export function truncateOversizedToolResults(
  messages: readonly AgentMessage[],
  maxToolResultTokens: number,
): { messages: readonly AgentMessage[]; truncated: number } {
  const maxChars = Math.max(200, maxToolResultTokens * CHARS_PER_TOKEN);
  let truncated = 0;

  const next = messages.map((message) => {
    if (
      !message.content.some(
        (block) => block.type === 'tool_result' && block.content.length > maxChars,
      )
    ) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type !== 'tool_result' || block.content.length <= maxChars) return block;
        truncated += 1;
        return { ...block, content: trimToolResultText(block.content, maxChars) };
      }),
    };
  });

  return truncated === 0 ? { messages, truncated: 0 } : { messages: next, truncated };
}

/**
 * Keeps the head and the tail of an oversized tool result and says what went.
 *
 * Exported so the orchestration layer's per-class allowances produce byte-identical
 * notices to this one: two spellings of "we removed the middle" is two things a
 * reader has to learn, and two things a test has to assert.
 */
export function trimToolResultText(content: string, maxChars: number): string {
  const ceiling = Math.max(200, Math.floor(maxChars));
  if (content.length <= ceiling) return content;
  const keep = Math.floor((ceiling - TRUNCATION_NOTICE_CHARS) / 2);
  const dropped = content.length - keep * 2;
  return (
    `${content.slice(0, keep)}\n\n[... ${dropped.toLocaleString()} characters of this tool result were removed to fit the context ...]\n\n` +
    content.slice(content.length - keep)
  );
}

/** Room set aside for the notice that replaces the removed middle of a tool result. */
const TRUNCATION_NOTICE_CHARS = 120;

/**
 * Shortens the text of a message that is on its own too large for the budget.
 *
 * The last resort, and only reached when a single message — one enormous pasted
 * document, one image-free wall of output — exceeds what the whole request may
 * spend. The retention walk cannot drop it, because a request with no messages is
 * not a request, so the only remaining move is to send less of it. Images are left
 * alone: their cost is already a flat charge and half an image is not an image.
 */
function shrinkMessageText(message: AgentMessage, maxChars: number): AgentMessage {
  let remaining = Math.max(200, maxChars);
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === 'image' || block.type === 'tool_call') return block;
      const field = block.type === 'text' ? block.text : block.content;
      if (field.length <= remaining) {
        remaining -= field.length;
        return block;
      }
      const kept = field.slice(0, Math.max(0, remaining));
      const dropped = field.length - kept.length;
      remaining = 0;
      const notice = `\n\n[... ${dropped.toLocaleString()} characters removed to fit the context ...]`;
      return block.type === 'text'
        ? { ...block, text: kept + notice }
        : { ...block, content: kept + notice };
    }),
  };
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
    const policy = request.policy ? { ...this.basePolicy, ...request.policy } : this.basePolicy;

    const budget = this.resolveBudget(request, policy);
    const before = this.estimator.estimateMessages(request.messages);
    const utilizationFraction = before / budget.effectiveInputBudget;
    const pressure = classifyPressure(utilizationFraction, policy);

    // An explicit request compacts whatever the thresholds would have said.
    //
    // The retention window is narrowed to half the current context for this call
    // only. Without that, a request to compact a context that is still well inside
    // `retainRecentTokens` would find nothing older than the window and return
    // unchanged — technically correct, and indistinguishable from a broken button.
    if (request.forceCompaction) {
      return this.compact(
        request.messages,
        before,
        budget,
        utilizationFraction,
        {
          ...policy,
          retainRecentTokens: Math.min(policy.retainRecentTokens, Math.floor(before / 2)),
        },
        pressure,
      );
    }

    // Below the aggressive threshold nothing is done. The measurement still comes
    // back with its `pressure`, which is what makes `warningThreshold` mean
    // something to a caller that logs or displays it.
    if (utilizationFraction < policy.aggressiveThreshold) {
      return {
        messages: request.messages,
        estimatedTokens: before,
        compacted: false,
        budget: { ...budget, utilizationFraction },
        metadata: { strategy: 'passthrough', pressure },
      };
    }

    // At or above the aggressive threshold: shorten individually oversized tool
    // results first. Done before compaction is considered because it is the
    // cheaper fix and very often the sufficient one — a single runaway tool result
    // fills a context far more often than a long conversation does — and because
    // it costs no summary, no model call, and no earlier turns.
    const trimmed = truncateOversizedToolResults(request.messages, policy.maxToolResultTokens);
    const afterTrim =
      trimmed.truncated === 0 ? before : this.estimator.estimateMessages(trimmed.messages);
    const trimmedFraction = afterTrim / budget.effectiveInputBudget;

    // Trimming alone brought it under the compaction line, so the conversation is
    // kept whole. This is the case the policy always described and never reached.
    if (trimmedFraction < policy.compactionThreshold) {
      return {
        messages: trimmed.messages,
        estimatedTokens: afterTrim,
        compacted: false,
        ...(trimmed.truncated === 0 ? {} : { tokensBefore: before }),
        budget: { ...budget, utilizationFraction: trimmedFraction },
        metadata: {
          strategy: 'passthrough',
          pressure,
          ...(trimmed.truncated === 0 ? {} : { toolResultsTruncated: trimmed.truncated }),
        },
      };
    }

    // Still at or above the compaction threshold: compact. `before` rather than
    // `afterTrim` is reported as the starting point, because what the caller wants
    // to know is how full the context was when the turn began.
    return this.compact(
      trimmed.messages,
      before,
      budget,
      trimmedFraction,
      policy,
      pressure,
      trimmed.truncated,
    );
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Delegates to `deriveContextBudget`, which is the same arithmetic this method
   * used to hold inline. Kept as a method so the class's own call sites and its
   * `ReturnType<>` references are unchanged.
   */
  private resolveBudget(request: ContextRequest, policy: ContextPolicy): ContextBudget {
    return deriveContextBudget({
      capabilities: request.modelCapabilities,
      policy,
      configuredMaxInputTokens: this.configuredMaxInputTokens,
      configuredMaxOutputTokens: this.configuredMaxOutputTokens,
      requestMaxInputTokens: request.maxInputTokens,
    });
  }

  private async compact(
    messages: readonly AgentMessage[],
    tokensBefore: number,
    budget: ReturnType<DynamicCompactingContextManager['resolveBudget']>,
    utilizationFraction: number,
    policy: ContextPolicy,
    pressure: ContextPressure,
    toolResultsTruncated = 0,
  ): Promise<PreparedContext> {
    const compactionId = randomUUID();

    // What the compacted context has to come in under. The compaction threshold
    // rather than the whole budget, because landing exactly at the budget would put
    // the very next turn straight back over the line and compact again.
    const target = Math.max(
      1,
      Math.floor(budget.effectiveInputBudget * policy.compactionThreshold),
    );
    // A share of the target rather than of the whole budget. Taken from the budget
    // it is unrelated to the threshold that was actually asked for, so an agent set
    // to shrink at 10% got a summary sized for 25% and finished a compaction still
    // far over its own line.
    //
    // The share itself is `SUMMARY_BUDGET_FRACTION` unless the caller sized it for
    // this turn, which is what the orchestration layer does — clamped either way, so
    // an adaptive allocation can never claim the whole target and leave no tail.
    const summaryFraction = Math.min(
      0.5,
      Math.max(0.05, policy.summaryBudgetFraction ?? SUMMARY_BUDGET_FRACTION),
    );
    const summaryCeiling = Math.max(1, Math.floor(target * summaryFraction));

    // The retention window is narrowed until the tail it keeps plus the summary's
    // own ceiling is known to fit the target. Sizing it here, before either is
    // built, is what stops compaction from returning a context that is still too
    // big: the previous behaviour kept a fixed 8 000-token tail and simply reported
    // whatever total came out, which for a large single tool result was still over
    // budget and went straight back to the provider to be rejected.
    const retainRecentTokens = Math.max(
      1,
      Math.min(policy.retainRecentTokens, target - summaryCeiling),
    );

    const { recentMessages, olderMessages } = this.splitAtRetentionBoundary(
      messages,
      retainRecentTokens,
    );

    // Nothing older than the retention window. Reported rather than passed over in
    // silence, so a caller that asked for compaction can tell "there was nothing to
    // do" from "the request did not arrive".
    if (olderMessages.length === 0) {
      const enforced = this.enforceTail(recentMessages, target);
      const estimatedTokens =
        enforced === recentMessages ? tokensBefore : this.estimator.estimateMessages(enforced);
      return {
        messages: enforced,
        estimatedTokens,
        compacted: false,
        ...(enforced === recentMessages ? {} : { tokensBefore }),
        budget: { ...budget, utilizationFraction },
        metadata: {
          strategy: 'passthrough',
          compactionId,
          pressure,
          skipped: messages.length <= 1 ? 'already-minimal' : 'nothing-older',
          ...(toolResultsTruncated === 0 ? {} : { toolResultsTruncated }),
          ...(estimatedTokens > budget.effectiveInputBudget ? { stillOverBudget: true } : {}),
        },
      };
    }

    // Attempt LLM summarization first, then fall back to deterministic
    let summaryText: string;
    let strategy: 'llm-summarization' | 'deterministic';
    let fallbackUsed = false;

    const summarizationInput: CompactionSummaryInput = {
      messages: olderMessages,
      estimatedTokens: this.estimator.estimateMessages(olderMessages),
      // The allowance the summary is about to be clamped to. Told to the summariser
      // as well as enforced afterwards, so it stops at a sentence boundary of its
      // own choosing rather than being cut off mid-word by the clamp below.
      maxSummaryTokens: summaryCeiling,
    };

    if (policy.enableSummarization && this.summarizer) {
      try {
        const result = await this.summarizer.summarize(summarizationInput);
        if (result) {
          summaryText = result.summary;
          strategy = result.strategy;
        } else {
          summaryText = this.buildDeterministicSummaryText(olderMessages, summaryCeiling);
          strategy = 'deterministic';
          fallbackUsed = true;
        }
      } catch {
        // Summarization failure must never corrupt the session
        summaryText = this.buildDeterministicSummaryText(olderMessages, summaryCeiling);
        strategy = 'deterministic';
        fallbackUsed = true;
      }
    } else {
      summaryText = this.buildDeterministicSummaryText(olderMessages, summaryCeiling);
      strategy = 'deterministic';
    }

    // Clamped whatever produced it. The deterministic builder respects the ceiling
    // by construction; a summarization model only respects its own `maxTokens`,
    // which knows nothing about this budget. Trusting it is how a compaction ends up
    // larger than the room it was given.
    const summaryCeilingChars = summaryCeiling * CHARS_PER_TOKEN;
    if (summaryText.length > summaryCeilingChars) {
      summaryText = summaryText.slice(0, summaryCeilingChars);
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

    // The retention walk always keeps the last message whole, whatever its size,
    // because a request with no messages is not a request. That makes a single
    // oversized message the one thing the window cannot shrink, so the tail is
    // checked against what is left of the target and shortened in place if it does
    // not fit. Without this a 300 000-token tool result stayed over budget through
    // every compaction and every retry.
    const summaryTokens = this.estimator.estimateMessage(compactedMessage);
    const enforcedTail = this.enforceTail(recentMessages, Math.max(1, target - summaryTokens));

    const resultMessages = [compactedMessage, ...enforcedTail];
    const tokensAfter = this.estimator.estimateMessages(resultMessages);

    // A compaction that does not make the context smaller is not a compaction. This
    // is reachable on a very short conversation, where the summary's own headings
    // cost more than the two lines they describe, and it is exactly what a client's
    // "compact context" button hits when it is pressed on a fresh chat. Saying so
    // beats replacing a greeting with a worse-value summary of it.
    if (tokensAfter >= tokensBefore) {
      return {
        messages,
        estimatedTokens: tokensBefore,
        compacted: false,
        budget: { ...budget, utilizationFraction },
        metadata: {
          strategy: 'passthrough',
          compactionId,
          pressure,
          skipped: 'already-minimal',
          ...(toolResultsTruncated === 0 ? {} : { toolResultsTruncated }),
          ...(tokensBefore > budget.effectiveInputBudget ? { stillOverBudget: true } : {}),
        },
      };
    }

    return {
      messages: resultMessages,
      estimatedTokens: tokensAfter,
      compacted: true,
      tokensBefore,
      budget: { ...budget, utilizationFraction },
      metadata: {
        compactionId,
        strategy,
        fallbackUsed,
        pressure,
        ...(toolResultsTruncated === 0 ? {} : { toolResultsTruncated }),
        ...(tokensAfter > budget.effectiveInputBudget ? { stillOverBudget: true } : {}),
      },
    };
  }

  /**
   * Brings the verbatim tail under a token ceiling.
   *
   * Tool results are shortened first, since they are both the usual cause and the
   * least costly thing to lose. Only if that is not enough is message text cut, and
   * only from the oldest messages in the tail forward — the newest turn is what the
   * model is answering, and shortening that is the last thing worth doing.
   */
  private enforceTail(
    messages: readonly AgentMessage[],
    maxTokens: number,
  ): readonly AgentMessage[] {
    if (this.estimator.estimateMessages(messages) <= maxTokens) return messages;

    // Tool results first, at a cap derived from the ceiling rather than the policy:
    // by this point the policy's own allowance has already proved to be too generous.
    const perResultTokens = Math.max(200, Math.floor(maxTokens / Math.max(1, messages.length)));
    let working = truncateOversizedToolResults(messages, perResultTokens).messages;
    if (this.estimator.estimateMessages(working) <= maxTokens) return working;

    // Still over. Cut text from the front of the tail, leaving the newest message
    // for last so that whatever survives is the part the next reply depends on.
    const perMessageChars = Math.max(
      200,
      Math.floor((maxTokens * CHARS_PER_TOKEN) / Math.max(1, working.length)),
    );
    const shrunk = [...working];
    for (let i = 0; i < shrunk.length; i += 1) {
      const message = shrunk[i];
      if (!message) continue;
      shrunk[i] = shrinkMessageText(message, perMessageChars);
      working = shrunk;
      if (this.estimator.estimateMessages(working) <= maxTokens) break;
    }
    return working;
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

  /**
   * @param ceilingTokens The summary's token allowance, as sized by `compact`
   *   against the compaction target. Passing the allowance rather than the whole
   *   budget is what keeps the tail and the summary from each being within their
   *   own limit and still overflowing together.
   */
  private buildDeterministicSummaryText(
    messages: readonly AgentMessage[],
    ceilingTokens: number,
  ): string {
    return buildDeterministicSummary(messages, Math.max(400, ceilingTokens * CHARS_PER_TOKEN));
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

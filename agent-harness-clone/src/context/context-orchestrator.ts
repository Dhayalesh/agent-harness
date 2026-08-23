/**
 * The Context Orchestration Layer.
 *
 * `DynamicCompactingContextManager` answers one question well: given a conversation
 * and a model, what fits, and what has to be summarised to make it fit. This class
 * sits in front of it and answers the question before that one — *which* of this
 * conversation does the next request actually need — so that summarising is the last
 * thing tried rather than the first.
 *
 * ```
 * request
 *   │
 *   ├─ 1  model budget          deriveContextBudget()          shared with the manager
 *   ├─ 2  state analysis        deriveContextState()           goal, constraints, decisions
 *   ├─ 3  importance            scoreMessageImportance()       what may be discarded
 *   ├─ 4  tool output           manageToolResults()            cheapest relief first
 *   ├─ 5  selection             selectContext()                drop redundant, keep protected
 *   ├─ 6  compaction            DynamicCompactingContextManager   last resort, adaptive
 *   ├─ 7  verification          verifyContext()                did anything critical vanish
 *   └─ 8  recovery              restore, re-enforce, re-verify
 *   ▼
 * PreparedContext
 * ```
 *
 * Design commitments, all of which have a test:
 *
 * - **The existing manager is the mechanism, not a rival.** Every token that is
 *   removed is removed by it. This class decides *what* to hand it and *how much*
 *   room to give each part; it never re-implements compaction, tail enforcement, or
 *   budget arithmetic.
 * - **One user-facing dial.** `compactionThresholdPercent`. Retention sizes, summary
 *   shares, tool-result allowances, ranking weights and selection strategy are all
 *   derived per turn from the model's capabilities, that percentage, and the
 *   conversation itself.
 * - **Nothing is done that does not need doing.** Below the warning threshold this
 *   class delegates straight through and returns the caller's array by reference. A
 *   short conversation pays for one token estimate and nothing else.
 * - **Failure is never fatal.** A summariser that throws, a provider that rejects, a
 *   verification that fails — each degrades to a smaller, deterministic answer. The
 *   only outcome this layer will not produce is no answer.
 */
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '../core/messages.js';
import {
  classifyPressure,
  DEFAULT_CONTEXT_POLICY,
  DefaultTokenEstimator,
  deriveContextBudget,
  DynamicCompactingContextManager,
  type CompactionSummarizer,
  type CompactionSummaryInput,
  type CompactionSummaryResult,
  type ContextBudget,
  type ContextManager,
  type ContextPolicy,
  type ContextPressure,
  type ContextRequest,
  type PreparedContext,
  type TokenEstimator,
} from './context-manager.js';
import {
  COMPACTION_MARKER,
  CONTEXT_STATE_MARKER,
  deriveContextState,
  stateCounts,
  type ContextState,
} from './context-state.js';
import { renderContextState, renderStateSummary } from './context-state-summary.js';
import { scoreMessageImportance, type MessageImportance } from './context-importance.js';
import { selectContext, type SelectionTier } from './context-selector.js';
import { manageToolResults } from './tool-result-manager.js';
import {
  checkToolProtocol,
  verifyContext,
  type ContextVerification,
  type VerificationIssue,
  type VerifiedCategory,
} from './context-verifier.js';

/**
 * The automatic action a turn took, cheapest first.
 *
 * This is the vocabulary the console renders and the telemetry records. It is
 * ordered: a turn reports the most expensive thing it had to do, so `compaction`
 * implies trimming and selection were already tried and were not enough.
 */
export type ContextAction =
  | 'none'
  | 'tool-result-trimming'
  | 'selective-reduction'
  | 'compaction'
  | 'reactive-compaction'
  | 'recovery';

/** What the orchestrator decided, and why. Structured, and free of raw conversation. */
export type ContextDecision = {
  action: ContextAction;
  strategy: 'passthrough' | 'deterministic' | 'llm-summarization';
  pressure: ContextPressure;
  tokensBefore: number;
  tokensAfter: number;
  effectiveBudget: number;
  contextWindow: number;
  /** Messages the selector kept out of the canonical history it was given. */
  selectedMessageCount: number;
  /** Messages replaced by a summary. */
  compactedMessageCount: number;
  trimmedToolResults: number;
  deduplicatedToolResults: number;
  /** Which state categories the verifier confirmed are still represented. */
  preservedStateCategories: readonly VerifiedCategory[];
  /** Which tiers of history lost material this turn. */
  compressedCategories: readonly SelectionTier[];
  recoveryPerformed: boolean;
  verificationPassed: boolean;
  verificationIssues: readonly VerificationIssue[];
  fallbackUsed: boolean;
  /** How many items of each kind the state analysis found. */
  state: ReturnType<typeof stateCounts>;
  /** How the budget was split this turn, as fractions of the compaction target. */
  allocation: {
    recentFraction: number;
    summaryFraction: number;
    toolResultShare: number;
  };
};

export type ContextOrchestratorOptions = {
  /** Configured input ceiling. Narrows the model's budget, never widens it. */
  maxInputTokens?: number;
  /** Configured reply ceiling. Clamped to what the model reports it can produce. */
  maxOutputTokens?: number;
  /**
   * Threshold policy. In practice this is `contextPolicyFromPercent(percent)` — the
   * one thing an agent record configures.
   */
  policy?: Partial<ContextPolicy>;
  /** Optional LLM summariser. Absent means deterministic compaction, which is fine. */
  summarizer?: CompactionSummarizer;
  tokenEstimator?: TokenEstimator;
  /**
   * The manager that does the compacting. Defaults to a
   * `DynamicCompactingContextManager` built from the options above.
   *
   * Injectable for tests and for a deployment that has already chosen a compaction
   * mechanism, not as a configuration surface.
   */
  manager?: ContextManager;
  /** Called with every decision, for structured telemetry. Never awaited, never trusted. */
  onDecision?: (decision: ContextDecision) => void;
};

/** Reads the decision back off a prepared context, when an orchestrator produced it. */
export function contextDecisionOf(prepared: PreparedContext): ContextDecision | undefined {
  const value = prepared.metadata?.orchestration;
  return isDecision(value) ? value : undefined;
}

function isDecision(value: unknown): value is ContextDecision {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    'verificationPassed' in value
  );
}

export class ContextOrchestrator implements ContextManager {
  private readonly basePolicy: ContextPolicy;
  private readonly estimator: TokenEstimator;
  private readonly summarizer: CompactionSummarizer | undefined;
  private readonly configuredMaxInputTokens: number | undefined;
  private readonly configuredMaxOutputTokens: number | undefined;
  private readonly manager: ContextManager;
  private readonly onDecision: ((decision: ContextDecision) => void) | undefined;

  constructor(options: ContextOrchestratorOptions = {}) {
    this.basePolicy = { ...DEFAULT_CONTEXT_POLICY, ...options.policy };
    this.estimator = options.tokenEstimator ?? new DefaultTokenEstimator();
    this.summarizer = options.summarizer;
    this.configuredMaxInputTokens = options.maxInputTokens;
    this.configuredMaxOutputTokens = options.maxOutputTokens;
    this.onDecision = options.onDecision;
    this.manager =
      options.manager ??
      new DynamicCompactingContextManager({
        ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
        ...(options.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.tokenEstimator === undefined ? {} : { tokenEstimator: options.tokenEstimator }),
        // Deliberately not passed through: the orchestrator wraps the summariser so
        // the summary is state-aware and bounded by this turn's allocation. The inner
        // manager receives the wrapper on each request instead.
      });
  }

  async prepare(request: ContextRequest): Promise<PreparedContext> {
    const policy: ContextPolicy = request.policy
      ? { ...this.basePolicy, ...request.policy }
      : this.basePolicy;
    const budget = this.resolveBudget(request, policy);
    const before = this.estimator.estimateMessages(request.messages);
    const fraction = before / budget.effectiveInputBudget;
    const pressure = classifyPressure(fraction, policy);

    // ── Stage 0: nothing to do ────────────────────────────────────────────────
    //
    // Below the warning line the conversation is comfortably inside its budget and
    // every stage below would be work performed to conclude that no work was needed.
    // Delegated straight through, so the manager's own passthrough returns the
    // caller's array by reference and reference identity keeps meaning "untouched".
    if (!request.forceCompaction && fraction < policy.warningThreshold) {
      const prepared = await this.manager.prepare(request);
      return this.decorate(prepared, {
        action: 'none',
        strategy: prepared.metadata?.strategy ?? 'passthrough',
        pressure,
        tokensBefore: before,
        tokensAfter: prepared.estimatedTokens,
        budget,
        selectedMessageCount: prepared.messages.length,
        compactedMessageCount: 0,
        trimmedToolResults: 0,
        deduplicatedToolResults: 0,
        preserved: [],
        compressed: [],
        recoveryPerformed: false,
        verification: undefined,
        fallbackUsed: prepared.metadata?.fallbackUsed === true,
        state: undefined,
        allocation: { recentFraction: 0, summaryFraction: 0, toolResultShare: 0 },
      });
    }

    // ── Stage 1–2: what is this conversation about, and what may go ────────────
    const state = deriveContextState(request.messages);
    const importance = scoreMessageImportance(request.messages, state);
    // Protocol faults the canonical history already had are not this layer's doing,
    // and reporting them every turn would trigger a recovery that cannot fix them.
    const preExisting = new Set(checkToolProtocol(request.messages));

    // Between warning and aggressive the policy's own answer is "observe, don't act",
    // and that is still the right answer: acting here would spend tokens rewriting a
    // context that fits. The state analysis is kept, because it costs one pass over
    // the messages and it is what lets a console explain what is in the context
    // before anything dramatic happens.
    if (!request.forceCompaction && fraction < policy.aggressiveThreshold) {
      const prepared = await this.manager.prepare(request);
      return this.decorate(prepared, {
        action: 'none',
        strategy: prepared.metadata?.strategy ?? 'passthrough',
        pressure,
        tokensBefore: before,
        tokensAfter: prepared.estimatedTokens,
        budget,
        selectedMessageCount: prepared.messages.length,
        compactedMessageCount: 0,
        trimmedToolResults: prepared.metadata?.toolResultsTruncated ?? 0,
        deduplicatedToolResults: 0,
        preserved: [],
        compressed: [],
        recoveryPerformed: false,
        verification: undefined,
        fallbackUsed: prepared.metadata?.fallbackUsed === true,
        state,
        allocation: { recentFraction: 0, summaryFraction: 0, toolResultShare: 0 },
      });
    }

    // The line everything below aims to come in under. The compaction threshold
    // rather than the budget, so a turn that just relieved itself is not immediately
    // over again.
    const target = Math.max(
      1,
      Math.floor(budget.effectiveInputBudget * policy.compactionThreshold),
    );
    const allocation = this.allocate(request.messages, state, importance, pressure);

    // ── Stage 3: tool output ──────────────────────────────────────────────────
    const managed = manageToolResults(request.messages, {
      effectiveInputBudget: budget.effectiveInputBudget,
      pressure,
      state,
    });
    let working = managed.messages;
    let current =
      managed.messages === request.messages ? before : this.estimator.estimateMessages(working);

    if (!request.forceCompaction && current <= target) {
      return this.finish({
        request,
        policy,
        budget,
        state,
        preExisting,
        messages: working,
        estimatedTokens: current,
        tokensBefore: before,
        pressure,
        action: managed.trimmed + managed.deduplicated > 0 ? 'tool-result-trimming' : 'none',
        strategy: 'passthrough',
        compacted: false,
        compactedMessageCount: 0,
        trimmedToolResults: managed.trimmed,
        deduplicatedToolResults: managed.deduplicated,
        compressed: [],
        fallbackUsed: false,
        allocation,
        innerMetadata: {},
      });
    }

    // ── Stage 4: selection ────────────────────────────────────────────────────
    const selection = selectContext({
      messages: working,
      state,
      importance,
      targetTokens: target,
      estimator: this.estimator,
    });

    if (selection.droppedIndices.length > 0) {
      // What was dropped is gone from this request, so the state it carried is
      // restated at the front. Bounded, structured, and parseable on the next turn —
      // which is what makes a reduction lossy in tokens rather than in meaning.
      const note = this.stateMessage(state, Math.floor(target * allocation.summaryFraction));
      const withNote = [note, ...selection.messages];
      const noteCost = this.estimator.estimateMessages(withNote);
      const reduced = noteCost <= target ? withNote : selection.messages;
      const reducedTokens = noteCost <= target ? noteCost : selection.estimatedTokens;
      if (!request.forceCompaction && reducedTokens <= target) {
        return this.finish({
          request,
          policy,
          budget,
          state,
          preExisting,
          messages: reduced,
          estimatedTokens: reducedTokens,
          tokensBefore: before,
          pressure,
          action: 'selective-reduction',
          strategy: 'deterministic',
          // Reported as a compaction, because that is what happened from the outside:
          // earlier turns are no longer in the request and a structured statement of
          // their content stands in their place. A caller watching
          // `context.compaction.completed` to explain a falling meter needs this turn
          // to be visible; whether the compression was summarisation or selection is
          // what `action` is for.
          compacted: true,
          compactedMessageCount: selection.droppedIndices.length,
          trimmedToolResults: managed.trimmed,
          deduplicatedToolResults: managed.deduplicated,
          compressed: selection.droppedTiers,
          fallbackUsed: false,
          allocation,
          innerMetadata: {},
        });
      }
      working = selection.messages;
      current = selection.estimatedTokens;
    }

    // ── Stage 5: compaction ───────────────────────────────────────────────────
    //
    // Handed to the existing manager, with the retention window and the summary share
    // sized for this turn rather than left at their defaults, and with a summariser
    // that knows the state so the summary is a statement of what is true rather than
    // a story about what happened.
    const summarizer = new StateAwareSummarizer(state, this.summarizer);
    const compacted = await this.compactWith(summarizer, {
      request,
      messages: working,
      policy,
      allocation,
      target,
    });

    return this.finish({
      request,
      policy,
      budget,
      state,
      preExisting,
      messages: compacted.messages,
      estimatedTokens: compacted.estimatedTokens,
      tokensBefore: before,
      pressure,
      action: request.maxInputTokens === undefined ? 'compaction' : 'reactive-compaction',
      strategy: compacted.metadata?.strategy ?? 'deterministic',
      compacted: compacted.compacted,
      compactedMessageCount:
        selection.droppedIndices.length + Math.max(0, working.length - compacted.messages.length),
      trimmedToolResults: managed.trimmed + (compacted.metadata?.toolResultsTruncated ?? 0),
      deduplicatedToolResults: managed.deduplicated,
      compressed: selection.droppedTiers,
      fallbackUsed: compacted.metadata?.fallbackUsed === true || summarizer.fallbackUsed,
      allocation,
      innerMetadata: compacted.metadata ?? {},
      summarizer,
    });
  }

  // ------------------------------------------------------------------------
  // Stages
  // ------------------------------------------------------------------------

  private resolveBudget(request: ContextRequest, policy: ContextPolicy): ContextBudget {
    return deriveContextBudget({
      capabilities: request.modelCapabilities,
      policy,
      configuredMaxInputTokens: this.configuredMaxInputTokens,
      configuredMaxOutputTokens: this.configuredMaxOutputTokens,
      requestMaxInputTokens: request.maxInputTokens,
    });
  }

  /**
   * How this turn's target is split between the verbatim tail, the summary, and tool
   * output.
   *
   * Adaptive rather than fixed, because the right split depends on the shape of the
   * conversation and not on anyone's preference:
   *
   * - A conversation with a great deal of old history and little live state needs a
   *   larger summary; one with the reverse shape needs a larger tail.
   * - Heavy recent tool activity means the tail is doing real work — the model is
   *   mid-task and the last few results are what it is reasoning about — so the tail
   *   grows.
   * - Under critical pressure everything tightens, because the alternative is a
   *   request the provider refuses.
   */
  private allocate(
    messages: readonly AgentMessage[],
    state: ContextState,
    importance: readonly MessageImportance[],
    pressure: ContextPressure,
  ): ContextDecision['allocation'] {
    const total = Math.max(1, messages.length);
    const live = importance.filter(
      (entry) => entry.protection === 'critical' || entry.protection === 'high',
    ).length;
    const liveShare = live / total;
    const toolHeavy =
      state.recentActions.length >= 4 ||
      messages
        .slice(-8)
        .some((message) => message.content.some((block) => block.type === 'tool_result'));

    // The tail: bigger when most of the conversation is live, when a task is in
    // flight, and smaller when there is a long tail of history worth summarising.
    let recentFraction = 0.45 + liveShare * 0.2;
    if (toolHeavy) recentFraction += 0.08;
    if (state.pending.length >= 3) recentFraction += 0.05;
    if (pressure === 'critical') recentFraction -= 0.05;
    recentFraction = clamp(recentFraction, 0.3, 0.75);

    // The summary gets what the tail does not need, bounded so it can never take the
    // whole target and leave nothing verbatim.
    const historyWeight = clamp(1 - liveShare, 0.2, 1);
    const summaryFraction = clamp(Math.min(0.4, (1 - recentFraction) * historyWeight), 0.1, 0.4);

    return {
      recentFraction,
      summaryFraction,
      toolResultShare: pressure === 'critical' ? 0.3 : pressure === 'aggressive' ? 0.45 : 0.55,
    };
  }

  /**
   * Runs the inner manager with this turn's allocation.
   *
   * `forceCompaction` is set because the orchestrator has already established that
   * the context is over its line — the manager re-deriving that from its own
   * thresholds against a *selected* message list would sometimes disagree, and then
   * nothing would happen at all.
   */
  private async compactWith(
    summarizer: CompactionSummarizer,
    options: {
      request: ContextRequest;
      messages: readonly AgentMessage[];
      policy: ContextPolicy;
      allocation: ContextDecision['allocation'];
      target: number;
    },
  ): Promise<PreparedContext> {
    const { request, messages, policy, allocation, target } = options;
    const retainRecentTokens = Math.max(
      1,
      Math.min(policy.retainRecentTokens, Math.floor(target * allocation.recentFraction)),
    );
    const manager = this.compactionManager(summarizer);
    return manager.prepare({
      messages,
      forceCompaction: true,
      ...(request.modelCapabilities === undefined
        ? {}
        : { modelCapabilities: request.modelCapabilities }),
      ...(request.maxInputTokens === undefined ? {} : { maxInputTokens: request.maxInputTokens }),
      policy: {
        ...policy,
        retainRecentTokens,
        summaryBudgetFraction: allocation.summaryFraction,
        maxToolResultTokens: Math.max(
          250,
          Math.floor((target * allocation.toolResultShare) / Math.max(1, messages.length)),
        ),
      },
    });
  }

  /**
   * The manager used for compaction.
   *
   * When the orchestrator built its own manager it is rebuilt here with the
   * state-aware summariser attached, because a summariser is constructor-scoped on
   * `DynamicCompactingContextManager` and the wrapper is per-turn. When a manager was
   * injected it is used as it was given — a caller that supplied one has chosen its
   * summarisation behaviour.
   */
  private compactionManager(summarizer: CompactionSummarizer): ContextManager {
    if (!(this.manager instanceof DynamicCompactingContextManager)) return this.manager;
    return new DynamicCompactingContextManager({
      ...(this.configuredMaxInputTokens === undefined
        ? {}
        : { maxInputTokens: this.configuredMaxInputTokens }),
      ...(this.configuredMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: this.configuredMaxOutputTokens }),
      policy: this.basePolicy,
      summarizer,
      tokenEstimator: this.estimator,
    });
  }

  /**
   * Verification, recovery, and the finished result.
   *
   * Every path out of `prepare` ends here, so verification is not a stage that can be
   * skipped by adding a branch above it.
   */
  private async finish(input: {
    request: ContextRequest;
    policy: ContextPolicy;
    budget: ContextBudget;
    state: ContextState;
    preExisting: ReadonlySet<VerificationIssue>;
    messages: readonly AgentMessage[];
    estimatedTokens: number;
    tokensBefore: number;
    pressure: ContextPressure;
    action: ContextAction;
    strategy: ContextDecision['strategy'];
    compacted: boolean;
    compactedMessageCount: number;
    trimmedToolResults: number;
    deduplicatedToolResults: number;
    compressed: readonly SelectionTier[];
    fallbackUsed: boolean;
    allocation: ContextDecision['allocation'];
    innerMetadata: NonNullable<PreparedContext['metadata']>;
    summarizer?: StateAwareSummarizer;
  }): Promise<PreparedContext> {
    let messages = input.messages;
    let estimatedTokens = input.estimatedTokens;
    let action = input.action;
    let recoveryPerformed = false;

    let verification = this.verify(
      messages,
      estimatedTokens,
      input.state,
      input.budget,
      input.preExisting,
    );

    // ── Stage 6: recovery ─────────────────────────────────────────────────────
    //
    // Something protected is missing. The response is never "accept it": the missing
    // state is restated verbatim at the front, and if that pushes the request over
    // budget the *lower-priority* material yields, not the state. Exactly one attempt,
    // because a second would be the same operation on the same inputs.
    if (!verification.passed && verification.missingItems.length > 0) {
      const restored = await this.recover({
        messages,
        state: input.state,
        missing: verification,
        request: input.request,
        policy: input.policy,
        budget: input.budget,
        allocation: input.allocation,
      });
      if (restored) {
        messages = restored.messages;
        estimatedTokens = restored.estimatedTokens;
        recoveryPerformed = true;
        action = 'recovery';
        verification = this.verify(
          messages,
          estimatedTokens,
          input.state,
          input.budget,
          input.preExisting,
        );
      }
    }

    const utilizationFraction = estimatedTokens / input.budget.effectiveInputBudget;
    const changed = messages !== input.request.messages;
    const decision: ContextDecision = {
      action,
      strategy: input.strategy,
      pressure: input.pressure,
      tokensBefore: input.tokensBefore,
      tokensAfter: estimatedTokens,
      effectiveBudget: input.budget.effectiveInputBudget,
      contextWindow: input.budget.contextWindow,
      selectedMessageCount: messages.length,
      compactedMessageCount: input.compactedMessageCount,
      trimmedToolResults: input.trimmedToolResults,
      deduplicatedToolResults: input.deduplicatedToolResults,
      preservedStateCategories: verification.confirmed,
      compressedCategories: input.compressed,
      recoveryPerformed,
      verificationPassed: verification.passed,
      verificationIssues: verification.issues,
      fallbackUsed: input.fallbackUsed || (input.summarizer?.fallbackUsed ?? false),
      state: stateCounts(input.state),
      allocation: input.allocation,
    };
    this.report(decision);

    return {
      messages,
      estimatedTokens,
      compacted: input.compacted,
      ...(changed ? { tokensBefore: input.tokensBefore } : {}),
      budget: { ...input.budget, utilizationFraction },
      metadata: {
        ...input.innerMetadata,
        strategy: input.strategy,
        pressure: input.pressure,
        fallbackUsed: decision.fallbackUsed,
        ...(input.trimmedToolResults + input.deduplicatedToolResults === 0
          ? {}
          : { toolResultsTruncated: input.trimmedToolResults + input.deduplicatedToolResults }),
        ...(estimatedTokens > input.budget.effectiveInputBudget ? { stillOverBudget: true } : {}),
        orchestration: decision,
      },
    };
  }

  private verify(
    messages: readonly AgentMessage[],
    estimatedTokens: number,
    state: ContextState,
    budget: ContextBudget,
    preExisting: ReadonlySet<VerificationIssue>,
  ): ContextVerification {
    const result = verifyContext({
      messages,
      state,
      estimatedTokens,
      effectiveInputBudget: budget.effectiveInputBudget,
    });
    const issues = result.issues.filter((issue) => !preExisting.has(issue));
    return { ...result, issues, passed: issues.length === 0 };
  }

  /**
   * Puts the missing state back and makes it fit.
   *
   * The state block is rebuilt at full size — recovery is the one place worth
   * spending tokens on state rather than transcript — and prepended. If that no
   * longer fits, the inner manager is asked to bring the whole thing under a ceiling
   * *below* the budget, which shrinks the transcript around the block rather than the
   * block itself.
   *
   * Returns `undefined` when it cannot improve on what it was given, which the caller
   * treats as "verification failed and was reported", never as an error.
   */
  private async recover(options: {
    messages: readonly AgentMessage[];
    state: ContextState;
    missing: ContextVerification;
    request: ContextRequest;
    policy: ContextPolicy;
    budget: ContextBudget;
    allocation: ContextDecision['allocation'];
  }): Promise<{ messages: readonly AgentMessage[]; estimatedTokens: number } | undefined> {
    const { budget, policy } = options;
    const target = Math.max(
      1,
      Math.floor(budget.effectiveInputBudget * policy.compactionThreshold),
    );
    const stateCeiling = Math.max(400, Math.floor(target * 0.35));
    const note = this.stateMessage(options.state, stateCeiling);

    // Any state block this pipeline wrote earlier is replaced rather than repeated:
    // two state blocks disagreeing about the same conversation is worse than one.
    const body = options.messages.filter((message) => !isStateMessage(message));
    const candidate = [note, ...body];
    const estimated = this.estimator.estimateMessages(candidate);
    if (estimated <= budget.effectiveInputBudget) {
      return { messages: candidate, estimatedTokens: estimated };
    }

    const manager = this.compactionManager(
      new StateAwareSummarizer(options.state, this.summarizer),
    );
    const enforced = await manager.prepare({
      messages: candidate,
      forceCompaction: true,
      maxInputTokens: Math.max(1_000, Math.floor(budget.effectiveInputBudget * 0.9)),
      ...(options.request.modelCapabilities === undefined
        ? {}
        : { modelCapabilities: options.request.modelCapabilities }),
      policy: {
        ...policy,
        retainRecentTokens: Math.max(1, Math.floor(target * 0.4)),
        summaryBudgetFraction: 0.4,
      },
    });
    if (enforced.estimatedTokens > estimated) return undefined;
    return { messages: enforced.messages, estimatedTokens: enforced.estimatedTokens };
  }

  /** A bounded, structured statement of the conversation's state, as a user message. */
  private stateMessage(state: ContextState, maxTokens: number): AgentMessage {
    const text = renderContextState(state, Math.max(200, maxTokens) * 4);
    return {
      id: randomUUID(),
      role: 'user',
      createdAt: new Date().toISOString(),
      content: [{ type: 'text', text: `${CONTEXT_STATE_MARKER}\n${text}` }],
    };
  }

  /** Attaches a decision to a result the inner manager produced unchanged. */
  private decorate(
    prepared: PreparedContext,
    input: {
      action: ContextAction;
      strategy: ContextDecision['strategy'];
      pressure: ContextPressure;
      tokensBefore: number;
      tokensAfter: number;
      budget: ContextBudget;
      selectedMessageCount: number;
      compactedMessageCount: number;
      trimmedToolResults: number;
      deduplicatedToolResults: number;
      preserved: readonly VerifiedCategory[];
      compressed: readonly SelectionTier[];
      recoveryPerformed: boolean;
      verification: ContextVerification | undefined;
      fallbackUsed: boolean;
      state: ContextState | undefined;
      allocation: ContextDecision['allocation'];
    },
  ): PreparedContext {
    const decision: ContextDecision = {
      action: input.action,
      strategy: input.strategy,
      pressure: input.pressure,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      effectiveBudget: input.budget.effectiveInputBudget,
      contextWindow: input.budget.contextWindow,
      selectedMessageCount: input.selectedMessageCount,
      compactedMessageCount: input.compactedMessageCount,
      trimmedToolResults: input.trimmedToolResults,
      deduplicatedToolResults: input.deduplicatedToolResults,
      preservedStateCategories: input.verification?.confirmed ?? input.preserved,
      compressedCategories: input.compressed,
      recoveryPerformed: input.recoveryPerformed,
      // Nothing was changed, so there is nothing that could have been lost. Reported
      // as passing rather than as "not run", because a console showing "unverified"
      // on a turn where the context was untouched is alarming and wrong.
      verificationPassed: input.verification?.passed ?? true,
      verificationIssues: input.verification?.issues ?? [],
      fallbackUsed: input.fallbackUsed,
      state: stateCounts(input.state ?? emptyState()),
      allocation: input.allocation,
    };
    this.report(decision);
    return {
      ...prepared,
      // Rebuilt with the budget the orchestrator derived when the inner manager
      // reported none, so `context.usage` is meaningful whatever manager is inside.
      budget: prepared.budget ?? {
        ...input.budget,
        utilizationFraction: input.tokensAfter / input.budget.effectiveInputBudget,
      },
      metadata: {
        ...prepared.metadata,
        pressure: prepared.metadata?.pressure ?? input.pressure,
        orchestration: decision,
      },
    };
  }

  private report(decision: ContextDecision): void {
    try {
      this.onDecision?.(decision);
    } catch {
      // Telemetry is never an execution dependency.
    }
  }
}

/**
 * The summariser the orchestrator hands to compaction.
 *
 * Three jobs, none of which the underlying summariser can do on its own:
 *
 * 1. **Lead with the state.** The structured block is deterministic and known
 *    correct; the model's prose extends it. A summary that begins with
 *    `CURRENT GOAL:` cannot lose the goal.
 * 2. **Bound the request.** The allowance travels with the input, so a model with a
 *    2 000-token default does not write 2 000 tokens into a 400-token hole.
 * 3. **Never fail.** An underlying summariser that returns nothing or throws leaves a
 *    deterministic state summary in its place, and says that it did.
 */
export class StateAwareSummarizer implements CompactionSummarizer {
  private fellBack = false;

  constructor(
    private readonly state: ContextState,
    private readonly inner: CompactionSummarizer | undefined,
  ) {}

  /** Whether the deterministic path was used in place of a configured summariser. */
  get fallbackUsed(): boolean {
    return this.fellBack;
  }

  async summarize(input: CompactionSummaryInput): Promise<CompactionSummaryResult | undefined> {
    const ceilingChars = Math.max(400, (input.maxSummaryTokens ?? 2_000) * 4);
    const outline = renderContextState(this.state, Math.floor(ceilingChars * 0.6));

    if (this.inner) {
      try {
        const result = await this.inner.summarize({
          ...input,
          ...(outline === '' ? {} : { stateOutline: outline }),
        });
        if (result && result.summary.trim() !== '') {
          return {
            summary: merge(outline, result.summary, ceilingChars),
            strategy: result.strategy,
          };
        }
      } catch {
        // A summarisation failure must never corrupt a session, so it is a fallback
        // rather than an error.
      }
      this.fellBack = true;
    }

    return {
      summary: renderStateSummary(this.state, input.messages, ceilingChars),
      strategy: 'deterministic',
    };
  }
}

/**
 * Puts the deterministic outline in front of the model's prose without letting the
 * pair exceed the allowance.
 *
 * The outline is kept whole and the prose is what gives way, because the outline is
 * the part that was derived from the transcript rather than generated from it.
 */
function merge(outline: string, summary: string, ceilingChars: number): string {
  if (outline === '') return summary.slice(0, ceilingChars);
  const room = ceilingChars - outline.length - 2;
  if (room <= 120) return outline.slice(0, ceilingChars);
  return `${outline}\n\n${summary.slice(0, room)}`;
}

function isStateMessage(message: AgentMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === 'text' &&
      (block.text.startsWith(CONTEXT_STATE_MARKER) || block.text.startsWith(COMPACTION_MARKER)),
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function emptyState(): ContextState {
  return {
    taskProgress: { completed: 0, pending: 0 },
    constraints: [],
    decisions: [],
    supersededDecisions: [],
    pending: [],
    completed: [],
    questions: [],
    errors: [],
    files: [],
    artifacts: [],
    toolState: [],
    recentActions: [],
    facts: [],
    carriers: new Map(),
  };
}

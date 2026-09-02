/**
 * Choosing what the next request actually needs, before anything is summarised.
 *
 * Compaction is lossy and expensive: it spends a model call, it replaces exact words
 * with a paraphrase, and once it has run the original wording is gone from the
 * request for good. So it should be the *last* mechanism, not the first. Very often
 * a context is over budget not because the conversation is long but because a third
 * of it is redundant — a superseded plan, four identical directory listings, a file
 * that was read twice, an exchange about a subject that was settled ten turns ago.
 *
 * Selection removes exactly that material, and nothing else, in the priority order
 * the layer publishes:
 *
 * ```
 * 1  system instructions        (composed outside this layer; never a message here)
 * 2  current user request
 * 3  active task state
 * 4  explicit constraints
 * 5  active decisions
 * 6  unresolved errors and questions
 * 7  relevant tool state
 * 8  relevant files and artifacts
 * 9  recent conversation
 * 10 relevant historical conversation
 * 11 low-value historical conversation      ← the only tier selection discards
 * ```
 *
 * Three invariants:
 *
 * - **Chronological order is preserved.** Messages are filtered, never re-ordered.
 *   Reordering a transcript is only safe in the trivial cases and catastrophic in the
 *   rest, and there is nothing to gain from it.
 * - **Tool call and tool result move together.** They are selected as one group, so
 *   a selection can never produce an orphan for the verifier to catch.
 * - **The last message always survives**, whatever it costs. A request with no
 *   messages is not a request; an oversized final message is the tail-enforcement
 *   problem, not this one.
 */
import type { AgentMessage } from '../core/messages.js';
import type { TokenEstimator } from './context-manager.js';
import type { ContextState } from './context-state.js';
import {
  byDiscardability,
  PROTECTION_ORDER,
  toolPairs,
  type MessageImportance,
} from './context-importance.js';

/** The tiers, in the order they are filled. */
export type SelectionTier =
  | 'current-request'
  | 'active-task'
  | 'constraints'
  | 'active-decisions'
  | 'errors-and-questions'
  | 'tool-state'
  | 'files-and-artifacts'
  | 'recent-conversation'
  | 'relevant-history'
  | 'low-value-history';

export type ContextSelection = {
  /** The input array by reference when nothing was dropped. */
  messages: readonly AgentMessage[];
  estimatedTokens: number;
  /** Canonical indices that survived, ascending. */
  keptIndices: readonly number[];
  /** Canonical indices that were left out, ascending. */
  droppedIndices: readonly number[];
  /** Which tiers contributed at least one kept message. */
  keptTiers: readonly SelectionTier[];
  /** Which tiers lost at least one message. */
  droppedTiers: readonly SelectionTier[];
};

const TIER_ORDER: readonly SelectionTier[] = [
  'current-request',
  'active-task',
  'constraints',
  'active-decisions',
  'errors-and-questions',
  'tool-state',
  'files-and-artifacts',
  'recent-conversation',
  'relevant-history',
  'low-value-history',
];

/**
 * Reduces the conversation to what fits, dropping only what it can justify.
 *
 * Returns the input by reference when it already fits, so a caller can keep using
 * reference identity to mean "untouched".
 *
 * @param targetTokens What the selection has to come in under. The caller sizes this
 *   against the compaction threshold, not the whole budget, so a successful selection
 *   does not leave the next turn immediately over the line again.
 */
export function selectContext(options: {
  messages: readonly AgentMessage[];
  state: ContextState;
  importance: readonly MessageImportance[];
  targetTokens: number;
  estimator: TokenEstimator;
  /** Exact request identities that selection must retain across later tool turns. */
  protectedMessageIds?: ReadonlySet<string>;
}): ContextSelection {
  const { messages, importance, estimator, targetTokens } = options;
  const before = estimator.estimateMessages(messages);
  const all = messages.map((_, index) => index);
  if (messages.length <= 1 || before <= targetTokens) {
    return {
      messages,
      estimatedTokens: before,
      keptIndices: all,
      droppedIndices: [],
      keptTiers: [],
      droppedTiers: [],
    };
  }

  const tiers = assignTiers(messages, options.state, importance, options.protectedMessageIds);
  const groups = groupsOf(messages);
  const groupOf = new Map<number, number[]>();
  for (const group of groups) for (const index of group) groupOf.set(index, group);

  /**
   * Per-message costs, measured once.
   *
   * The loop below asks "does this still fit?" once per candidate, and answering that
   * by re-serialising the whole subset each time is quadratic in a conversation's
   * length — the one place in this layer where a long session would pay a visible
   * cost. Individual estimates sum to very slightly less than the whole (the JSON
   * array wrapper), so the accounting runs additively here and the caller re-measures
   * the finished selection exactly.
   */
  const costs = messages.map((message) => estimator.estimateMessage(message));

  // Mandatory first: everything the next turn cannot be correct without. Sized before
  // anything optional is considered, because a selection that fits by dropping a
  // constraint has not solved the problem, it has moved it.
  const kept = new Set<number>();
  const mandatory = new Set(
    importance
      .filter((entry) => PROTECTION_ORDER[entry.protection] >= PROTECTION_ORDER.high)
      .map((entry) => entry.index),
  );
  for (const [index, message] of messages.entries()) {
    if (options.protectedMessageIds?.has(message.id)) mandatory.add(index);
  }
  for (const index of mandatory) includeGroup(index, kept, groupOf);
  includeGroup(messages.length - 1, kept, groupOf);

  let used = [...kept].reduce((total, index) => total + (costs[index] ?? 0), 0);

  // Then optional material, best first: by tier, and within a tier by how hard it
  // would be to justify losing it.
  const optional = importance
    .filter((entry) => !kept.has(entry.index))
    .sort((a, b) => {
      const tierDelta =
        TIER_ORDER.indexOf(tiers.get(a.index) ?? 'low-value-history') -
        TIER_ORDER.indexOf(tiers.get(b.index) ?? 'low-value-history');
      if (tierDelta !== 0) return tierDelta;
      return byDiscardability(b, a);
    });

  for (const entry of optional) {
    if (kept.has(entry.index)) continue;
    const addition = (groupOf.get(entry.index) ?? [entry.index]).filter(
      (index) => !kept.has(index),
    );
    const cost = addition.reduce((total, index) => total + (costs[index] ?? 0), 0);
    if (used + cost > targetTokens) continue;
    for (const index of addition) kept.add(index);
    used += cost;
  }

  const keptIndices = [...kept].sort((a, b) => a - b);
  const droppedIndices = all.filter((index) => !kept.has(index));
  if (droppedIndices.length === 0) {
    return {
      messages,
      estimatedTokens: before,
      keptIndices,
      droppedIndices: [],
      keptTiers: [],
      droppedTiers: [],
    };
  }

  const selected = keptIndices
    .map((index) => messages[index])
    .filter((message): message is AgentMessage => message !== undefined);
  return {
    messages: selected,
    // Measured exactly rather than carried over from the additive accounting above,
    // because this is the number the caller compares against the budget.
    estimatedTokens: estimator.estimateMessages(selected),
    keptIndices,
    droppedIndices,
    keptTiers: distinctTiers(keptIndices, tiers),
    droppedTiers: distinctTiers(droppedIndices, tiers),
  };
}

/**
 * The tier each message belongs to.
 *
 * A message can carry several kinds of state; it is filed under the highest tier it
 * qualifies for, because that is the tier that decides whether it may be discarded.
 */
export function assignTiers(
  messages: readonly AgentMessage[],
  state: ContextState,
  importance: readonly MessageImportance[],
  protectedMessageIds?: ReadonlySet<string>,
): Map<number, SelectionTier> {
  const tiers = new Map<number, SelectionTier>();
  const set = (index: number, tier: SelectionTier): void => {
    const existing = tiers.get(index);
    if (existing === undefined || TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(existing)) {
      tiers.set(index, tier);
    }
  };

  for (const entry of importance) {
    // Recency is the floor. Everything else can only improve a message's tier.
    set(
      entry.index,
      entry.reasons.includes('latest-turn') ? 'recent-conversation' : 'relevant-history',
    );
    if (entry.reasons.includes('duplicate') || entry.reasons.includes('superseded-decision')) {
      tiers.set(entry.index, 'low-value-history');
    }
    if (entry.reasons.includes('unreferenced-history') && entry.protection === 'low') {
      tiers.set(entry.index, 'low-value-history');
    }
  }

  for (const [index, kinds] of state.carriers) {
    for (const kind of kinds) {
      switch (kind) {
        case 'goal':
          set(index, 'current-request');
          break;
        case 'task':
          set(index, 'active-task');
          break;
        case 'constraint':
          set(index, 'constraints');
          break;
        case 'decision':
          set(index, 'active-decisions');
          break;
        case 'error':
        case 'question':
          set(index, 'errors-and-questions');
          break;
        case 'tool-state':
        case 'action':
          set(index, 'tool-state');
          break;
        case 'file':
        case 'artifact':
          set(index, 'files-and-artifacts');
          break;
        default:
          break;
      }
    }
  }

  // Explicit request identity outranks later tool-result messages in the same turn.
  for (const [index, message] of messages.entries()) {
    if (protectedMessageIds?.has(message.id)) tiers.set(index, 'current-request');
  }
  if (messages.length > 0 && protectedMessageIds === undefined) {
    tiers.set(messages.length - 1, 'current-request');
  }
  return tiers;
}

/**
 * Message groups that have to move together.
 *
 * A tool call and every message carrying one of its results. A provider validates
 * that pairing, so a group is atomic: including or dropping one member without the
 * others produces a request that is rejected outright rather than merely degraded.
 */
function groupsOf(messages: readonly AgentMessage[]): number[][] {
  const groups: number[][] = [];
  for (const [callIndex, resultIndices] of toolPairs(messages)) {
    groups.push([callIndex, ...resultIndices].sort((a, b) => a - b));
  }
  return groups;
}

function includeGroup(
  index: number,
  kept: Set<number>,
  groupOf: ReadonlyMap<number, number[]>,
): void {
  const group = groupOf.get(index);
  if (group === undefined) {
    kept.add(index);
    return;
  }
  for (const member of group) kept.add(member);
}

function distinctTiers(
  indices: readonly number[],
  tiers: ReadonlyMap<number, SelectionTier>,
): SelectionTier[] {
  const seen = new Set<SelectionTier>();
  for (const index of indices) {
    const tier = tiers.get(index);
    if (tier) seen.add(tier);
  }
  return TIER_ORDER.filter((tier) => seen.has(tier));
}

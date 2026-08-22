/**
 * The check that runs after the context has been decided and before it is sent.
 *
 * Every stage before this one is a heuristic. Importance ranking reads language,
 * selection reasons about tiers, compaction hands a conversation to a summarisation
 * model and hopes. Each is defensible on its own and each can be wrong, and the way
 * they are wrong is always the same: something the next turn needed is no longer in
 * the request, and nothing notices until the model answers as though it had never
 * been told.
 *
 * So the prepared context is verified against the state derived from the canonical
 * history — the one artefact in the pipeline that is a pure function of what the user
 * actually said. Verification is deliberately cheap and deliberately dumb: it looks
 * for evidence that each protected item is still represented, checks the tool
 * protocol, and checks the budget. It never rewrites anything. What to do about a
 * failure is the orchestrator's decision, because only the orchestrator knows what it
 * still has in hand to restore.
 */
import type { AgentMessage } from '../core/messages.js';
import {
  significantWords,
  type ContextState,
  type ContextStateItem,
} from './context-state.js';

export type VerificationIssue =
  | 'missing-goal'
  | 'missing-constraints'
  | 'missing-decisions'
  | 'missing-pending-work'
  | 'missing-errors'
  | 'missing-files'
  | 'orphaned-tool-result'
  | 'orphaned-tool-call'
  | 'superseded-presented-as-active'
  | 'over-budget'
  | 'empty-context';

/**
 * The name of a check that passed.
 *
 * Reported as well as the failures, because a console that can only say what went
 * wrong cannot say what was protected — and "your constraints and your active
 * decisions survived this compaction" is the sentence a user actually wants.
 */
export type VerifiedCategory =
  | 'goal'
  | 'constraints'
  | 'decisions'
  | 'pending-work'
  | 'errors'
  | 'files'
  | 'tool-protocol'
  | 'budget';

export type ContextVerification = {
  passed: boolean;
  issues: readonly VerificationIssue[];
  /** Which categories were confirmed intact. */
  confirmed: readonly VerifiedCategory[];
  /** The specific items that could not be found, bounded, for a recovery to restore. */
  missingItems: readonly ContextStateItem[];
};

/**
 * How much of an item's distinctive vocabulary has to survive for it to count as
 * present.
 *
 * Not exact-string matching: a summary is allowed to paraphrase, and demanding the
 * original wording would fail every LLM summary that did its job. Not one word
 * either, which any long context would satisfy by accident. Two thirds of an item's
 * significant words is the point where "this was preserved" and "these words happen
 * to appear" stop being confusable.
 */
const PRESENCE_RATIO = 0.66;

/** At most this many missing items are reported; a recovery cannot restore more usefully. */
const MAX_MISSING_REPORTED = 12;

/**
 * Confirms the prepared context still carries what the conversation depends on.
 *
 * @param options.estimatedTokens The prepared context's measured size. Passed in
 *   rather than re-measured so the verifier and the caller agree on one number.
 */
export function verifyContext(options: {
  messages: readonly AgentMessage[];
  state: ContextState;
  estimatedTokens: number;
  effectiveInputBudget: number;
}): ContextVerification {
  const { messages, state } = options;
  const issues: VerificationIssue[] = [];
  const confirmed: VerifiedCategory[] = [];
  const missingItems: ContextStateItem[] = [];

  if (messages.length === 0) {
    return {
      passed: false,
      issues: ['empty-context'],
      confirmed: [],
      missingItems: [],
    };
  }

  const vocabulary = vocabularyOf(messages);

  /**
   * @param tolerance What share of a category may be absent before it counts as a
   *   failure. Zero for the categories where losing one item is losing the point —
   *   the goal, a constraint, a live error. Higher for the long, enumerable
   *   categories, where a summary that names eight of twenty touched files has not
   *   lost the thread and forcing a recovery over it would spend the budget it was
   *   trying to save.
   */
  const check = (
    items: readonly ContextStateItem[],
    issue: VerificationIssue,
    category: VerifiedCategory,
    tolerance = 0,
  ): void => {
    if (items.length === 0) return;
    const missing = items.filter((entry) => !isPresent(entry, vocabulary));
    if (missing.length <= Math.floor(items.length * tolerance)) {
      confirmed.push(category);
      return;
    }
    issues.push(issue);
    missingItems.push(...missing);
  };

  check(state.currentGoal ? [state.currentGoal] : [], 'missing-goal', 'goal');
  check(state.constraints, 'missing-constraints', 'constraints');
  check(state.decisions, 'missing-decisions', 'decisions', 0.25);
  check(state.pending, 'missing-pending-work', 'pending-work', 0.3);
  check(state.errors, 'missing-errors', 'errors');
  // Files are matched by name, which is exact by nature, but there are many of them
  // and the tail of the list is genuinely less important than the head.
  check(state.files, 'missing-files', 'files', 0.5);

  // A decision that was overruled must not be the only version of that subject left
  // standing. This is the failure mode that makes an agent redo work it was told to
  // stop doing, and it is invisible in a token count.
  const activeWords = new Set(state.decisions.flatMap((entry) => significantWords(entry.text)));
  const supersededPresented = state.supersededDecisions.some((entry) => {
    if (!isPresent(entry, vocabulary)) return false;
    const words = significantWords(entry.text);
    if (words.length === 0) return false;
    // Only a problem when nothing states the newer position, so the model has no way
    // to tell which of the two applies.
    return words.filter((word) => activeWords.has(word)).length < 2;
  });
  if (supersededPresented && state.decisions.length > 0) {
    issues.push('superseded-presented-as-active');
  }

  const protocol = checkToolProtocol(messages);
  issues.push(...protocol);
  if (protocol.length === 0) confirmed.push('tool-protocol');

  if (options.estimatedTokens > options.effectiveInputBudget) {
    issues.push('over-budget');
  } else {
    confirmed.push('budget');
  }

  return {
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    confirmed: [...new Set(confirmed)],
    missingItems: missingItems.slice(0, MAX_MISSING_REPORTED),
  };
}

/**
 * Tool-protocol validity: every result has its call, and every call has its result.
 *
 * Both directions, because both are rejected. A result without its call is the
 * classic orphan; a call without its result is the one a naive "drop the oldest
 * messages" pass produces, and it fails just as hard on providers that require every
 * tool use to be answered.
 */
export function checkToolProtocol(messages: readonly AgentMessage[]): VerificationIssue[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') callIds.add(block.id);
      else if (block.type === 'tool_result') resultIds.add(block.toolCallId);
    }
  }
  const issues: VerificationIssue[] = [];
  for (const id of resultIds) {
    if (!callIds.has(id)) {
      issues.push('orphaned-tool-result');
      break;
    }
  }
  for (const id of callIds) {
    if (!resultIds.has(id)) {
      issues.push('orphaned-tool-call');
      break;
    }
  }
  return issues;
}

/** Every significant word in the prepared context, once. */
function vocabularyOf(messages: readonly AgentMessage[]): Set<string> {
  const words = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      const text =
        block.type === 'text'
          ? block.text
          : block.type === 'tool_result'
            ? block.content
            : block.type === 'tool_call'
              ? block.name
              : '';
      if (text === '') continue;
      for (const word of significantWords(text)) words.add(word);
    }
  }
  return words;
}

function isPresent(entry: ContextStateItem, vocabulary: ReadonlySet<string>): boolean {
  const words = significantWords(entry.text);
  if (words.length === 0) return true;
  const found = words.filter((word) => vocabulary.has(word)).length;
  return found / words.length >= PRESENCE_RATIO;
}

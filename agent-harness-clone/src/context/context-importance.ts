/**
 * How much each message is worth to the *next* request.
 *
 * The compaction layer's only ordering is time: the newest N tokens are kept and
 * everything older is summarised together. That is a reasonable default and a poor
 * rule, because age and relevance are not the same thing — a constraint stated in
 * the first turn governs the last one, and a 40 KB directory listing from two turns
 * ago governs nothing.
 *
 * This module produces the ordering the selector needs: a protection level per
 * message, derived from what `context-state.ts` found in it. No configuration is
 * exposed, because none of these weights is a matter of taste — they encode which
 * information a next turn cannot be correct without.
 */
import type { AgentMessage } from '../core/messages.js';
import {
  RECENT_WINDOW_MESSAGES,
  significantWords,
  textOf,
  type ContextItemKind,
  type ContextState,
} from './context-state.js';

/**
 * How freely a message may be discarded.
 *
 * - `critical` — the request cannot be answered correctly without it. Never dropped
 *   by selection, and its content is preserved through compaction.
 * - `high` — active state the next turn depends on. Dropped only after every
 *   `normal` and `low` message has gone, and then only under compaction.
 * - `normal` — ordinary recent conversation.
 * - `low` — superseded, duplicated, or unreferenced old material. The first thing
 *   to go, and the reason compaction is often not needed at all.
 */
export type ProtectionLevel = 'critical' | 'high' | 'normal' | 'low';

/** Why a message scored the way it did. Machine-readable, for telemetry. */
export type ImportanceReason =
  | 'current-request'
  | 'latest-turn'
  | 'user-instruction'
  | 'explicit-constraint'
  | 'active-goal'
  | 'active-decision'
  | 'superseded-decision'
  | 'unresolved-error'
  | 'pending-work'
  | 'open-question'
  | 'references-active-file'
  | 'recent-tool-activity'
  | 'tool-protocol-partner'
  | 'duplicate'
  | 'unreferenced-history';

export type MessageImportance = {
  index: number;
  /** 0–1, monotonic in "worth keeping". Used only to order within a protection level. */
  score: number;
  protection: ProtectionLevel;
  reasons: readonly ImportanceReason[];
  /** Index of the earlier message this one repeats, when it does. */
  duplicateOf?: number;
};

const PROTECTION_ORDER: Record<ProtectionLevel, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/** Which state kinds raise a message to which level. */
const KIND_PROTECTION: Partial<Record<ContextItemKind, ProtectionLevel>> = {
  goal: 'critical',
  constraint: 'critical',
  task: 'high',
  decision: 'high',
  error: 'high',
  question: 'high',
  file: 'normal',
  artifact: 'normal',
  action: 'normal',
  'tool-state': 'normal',
  fact: 'normal',
};

/**
 * Ranks every message against the state derived from the same conversation.
 *
 * Returned in message order, one entry per message, so a caller can index straight
 * into it.
 */
export function scoreMessageImportance(
  messages: readonly AgentMessage[],
  state: ContextState,
): MessageImportance[] {
  const count = messages.length;
  const goalWords = new Set(significantWords(state.currentGoal?.text ?? ''));
  const activeFiles = state.files.map((file) => file.text.toLowerCase());
  const supersededIndices = new Set(
    state.supersededDecisions.map((entry) => entry.messageIndex).filter((index) => index >= 0),
  );

  const seen = new Map<string, number>();
  const entries: MessageImportance[] = [];

  for (let index = 0; index < count; index += 1) {
    const message = messages[index];
    if (!message) {
      entries.push({ index, score: 0, protection: 'low', reasons: ['unreferenced-history'] });
      continue;
    }
    const reasons = new Set<ImportanceReason>();
    // Recency, as a gentle floor rather than the deciding factor. A message's
    // position is evidence, not a verdict.
    let score = 0.2 * ((index + 1) / count);
    // Held in an object rather than a plain `let`, because the closure below is the
    // only thing that changes it and control-flow narrowing would otherwise conclude
    // it is still `'low'` at every later comparison.
    const level: { value: ProtectionLevel } = { value: 'low' };

    const raise = (candidate: ProtectionLevel): void => {
      if (PROTECTION_ORDER[candidate] > PROTECTION_ORDER[level.value]) level.value = candidate;
    };

    const isLast = index === count - 1;
    if (isLast) {
      score += 1;
      raise('critical');
      reasons.add('current-request');
    }
    if (index >= count - RECENT_WINDOW_MESSAGES) {
      score += 0.25;
      raise('normal');
      reasons.add('latest-turn');
    }

    for (const kind of state.carriers.get(index) ?? []) {
      const level = KIND_PROTECTION[kind];
      if (level) raise(level);
      switch (kind) {
        case 'goal':
          score += 0.4;
          reasons.add('active-goal');
          break;
        case 'constraint':
          score += 0.5;
          reasons.add('explicit-constraint');
          break;
        case 'decision':
          score += 0.3;
          reasons.add('active-decision');
          break;
        case 'error':
          score += 0.35;
          reasons.add('unresolved-error');
          break;
        case 'task':
          score += 0.25;
          reasons.add('pending-work');
          break;
        case 'question':
          score += 0.2;
          reasons.add('open-question');
          break;
        case 'action':
        case 'tool-state':
          score += 0.1;
          reasons.add('recent-tool-activity');
          break;
        default:
          break;
      }
    }

    // A decision that was overruled is not just old, it is wrong. Keeping it around
    // as ordinary history invites the model to act on it again.
    if (supersededIndices.has(index) && !reasons.has('explicit-constraint')) {
      score -= 0.35;
      reasons.add('superseded-decision');
      if (level.value === 'high') level.value = 'normal';
    }

    if (message.role === 'user' && !isLast) {
      score += 0.1;
      reasons.add('user-instruction');
    }

    const text = textOf(message).toLowerCase();
    if (text !== '') {
      if (activeFiles.some((file) => text.includes(file))) {
        score += 0.15;
        raise('normal');
        reasons.add('references-active-file');
      }
      const overlap = significantWords(text).filter((word) => goalWords.has(word)).length;
      if (goalWords.size > 0 && overlap >= 2) {
        score += Math.min(0.2, overlap * 0.04);
        raise('normal');
      }
    }

    // Redundancy. Two identical tool results or two identical pasted blocks are one
    // piece of information billed twice, and the older copy is the one to lose.
    const fingerprint = fingerprintOf(message);
    let duplicateOf: number | undefined;
    if (fingerprint !== undefined) {
      const earlier = seen.get(fingerprint);
      if (earlier !== undefined) {
        duplicateOf = earlier;
        reasons.add('duplicate');
        score -= 0.3;
      } else {
        seen.set(fingerprint, index);
      }
    }

    // Nothing spoke for it: not recent, not referenced, carrying no state. That is a
    // finding rather than an absence of one, and it is what the selector discards
    // first.
    if (reasons.size === 0) reasons.add('unreferenced-history');

    entries.push({
      index,
      score: Math.max(0, Math.min(2, score)),
      protection: level.value,
      reasons: [...reasons],
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
    });
  }

  // A tool result and the call that produced it are one unit to the provider, so
  // they must also be one unit here: whichever is better protected lifts the other.
  // Without this the selector can make a protocol-valid choice look like a
  // protocol-invalid one and then have to undo it.
  for (const [callIndex, resultIndices] of toolPairs(messages)) {
    const group = [callIndex, ...resultIndices];
    let best: ProtectionLevel = 'low';
    let bestScore = 0;
    for (const index of group) {
      const entry = entries[index];
      if (!entry) continue;
      if (PROTECTION_ORDER[entry.protection] > PROTECTION_ORDER[best]) best = entry.protection;
      bestScore = Math.max(bestScore, entry.score);
    }
    for (const index of group) {
      const entry = entries[index];
      if (!entry) continue;
      entries[index] = {
        ...entry,
        protection: best,
        score: Math.max(entry.score, bestScore * 0.95),
        reasons:
          group.length > 1 && !entry.reasons.includes('tool-protocol-partner')
            ? [...entry.reasons, 'tool-protocol-partner']
            : entry.reasons,
      };
    }
  }

  return entries;
}

/**
 * Message indices grouped by tool call: the assistant message that made the call,
 * and every message carrying one of its results.
 *
 * Exported because the selector needs the same grouping to keep the pairs together,
 * and two implementations of "which messages belong to this call" is one too many.
 */
export function toolPairs(messages: readonly AgentMessage[]): Map<number, number[]> {
  const callIndexById = new Map<string, number>();
  const groups = new Map<number, number[]>();
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        callIndexById.set(block.id, index);
        if (!groups.has(index)) groups.set(index, []);
      }
    }
  });
  messages.forEach((message, index) => {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const callIndex = callIndexById.get(block.toolCallId);
      if (callIndex === undefined) continue;
      const group = groups.get(callIndex);
      if (group && !group.includes(index)) group.push(index);
    }
  });
  return groups;
}

/**
 * A content fingerprint, or `undefined` for messages too small to be worth
 * de-duplicating.
 *
 * Normalised whitespace and lowercase, so two runs of the same command that differ
 * only in indentation still register as the same output. Short messages are skipped:
 * "ok" appearing twice is not redundancy worth acting on.
 */
function fingerprintOf(message: AgentMessage): string | undefined {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_result') parts.push(block.content);
  }
  const joined = parts.join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
  return joined.length < 400 ? undefined : joined;
}

/** Ordering helper: worst-protected and lowest-scoring first. */
export function byDiscardability(a: MessageImportance, b: MessageImportance): number {
  const protection = PROTECTION_ORDER[a.protection] - PROTECTION_ORDER[b.protection];
  if (protection !== 0) return protection;
  return a.score - b.score;
}

export { PROTECTION_ORDER };

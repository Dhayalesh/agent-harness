/**
 * Turning the harness's context events into something a person can read.
 *
 * The harness decides everything: what to trim, what to drop, what to summarise,
 * whether the result verified. This module decides nothing — it accumulates what was
 * reported and gives the UI vocabulary for it. That split is deliberate. A console
 * that computes its own view of the context will eventually disagree with the runtime
 * about how full the window is, and the user has no way to tell which of the two is
 * lying.
 *
 * Pure functions with no React and no imports, so the shaping can be tested directly
 * rather than through a rendered component.
 */

/** How many turns of history the live view keeps. Matches the runtime's own bound. */
export const TIMELINE_LIMIT = 40;

/**
 * What each automatic action is called, and what it actually did.
 *
 * Written for someone who did not ask for any of this to happen and now wants to know
 * why their context meter moved. No jargon that only means something inside the
 * harness, and no passive voice hiding who acted.
 */
export const CONTEXT_ACTIONS = {
  none: {
    label: "No action needed",
    detail: "The conversation fits comfortably, so nothing was changed.",
  },
  "tool-result-trimming": {
    label: "Tool output shortened",
    detail:
      "Large or repeated command output was shortened. The conversation itself was left alone.",
  },
  "selective-reduction": {
    label: "Older material left out",
    detail:
      "Redundant and unreferenced earlier turns were left out of this request, with a summary of them kept in their place.",
  },
  compaction: {
    label: "Earlier turns summarised",
    detail:
      "Earlier turns were replaced by a structured summary so the model has room to keep going.",
  },
  "reactive-compaction": {
    label: "Retried with less context",
    detail:
      "The model rejected the request as too long, so the context was reduced and the turn was retried.",
  },
  recovery: {
    label: "Missing detail restored",
    detail:
      "A check found important detail missing after compression, so it was put back before the request was sent.",
  },
};

/** The categories the harness protects, in the order it protects them. */
export const PRESERVED_LABELS = {
  goal: "Current task",
  constraints: "Your constraints",
  decisions: "Decisions",
  "pending-work": "Pending work",
  errors: "Unresolved errors",
  files: "Relevant files",
  "tool-protocol": "Tool call integrity",
  budget: "Fits the budget",
};

/** The tiers of history that give way, worst first. */
export const COMPRESSED_LABELS = {
  "low-value-history": "Redundant older turns",
  "relevant-history": "Older conversation",
  "recent-conversation": "Recent conversation",
  "files-and-artifacts": "File and artifact detail",
  "tool-state": "Older tool output",
  "errors-and-questions": "Resolved errors and questions",
  "active-decisions": "Decision detail",
  constraints: "Constraint detail",
  "active-task": "Task detail",
  "current-request": "Current request detail",
};

export function actionLabel(action) {
  return CONTEXT_ACTIONS[action]?.label ?? null;
}

export function actionDetail(action) {
  return CONTEXT_ACTIONS[action]?.detail ?? null;
}

/**
 * Folds one event into the live context state.
 *
 * Returns the same object when the event says nothing about context, so a caller can
 * use reference identity to skip a re-render. Unknown fields are carried through
 * untouched: a runtime newer than this console still renders everything it does
 * understand.
 *
 * @param current `{ context, timeline, compactions, recoveries }`, or null.
 */
export function applyContextEvent(current, event) {
  const state = current ?? EMPTY_CONTEXT_STATE;
  switch (event?.type) {
    case "context.usage": {
      // The peak is a high water mark rather than the newest reading. Without it the
      // meter drops after a compaction and nothing on screen explains the gap.
      const candidate = event.peakTokens ?? event.usedTokens ?? 0;
      const peaked = candidate > (state.context?.peakTokens ?? 0);
      const timeline =
        event.turn === undefined && event.action === undefined
          ? state.timeline
          : [
              ...state.timeline,
              {
                ...(event.turn === undefined ? {} : { turn: event.turn }),
                usedPercent: event.usedPercent ?? 0,
                ...(event.action === undefined ? {} : { action: event.action }),
                ...(event.compacted === true ? { compacted: true } : {}),
              },
            ].slice(-TIMELINE_LIMIT);
      return {
        ...state,
        timeline,
        context: {
          usedTokens: event.usedTokens ?? 0,
          budgetTokens: event.budgetTokens ?? 0,
          contextWindow: event.contextWindow,
          reservedOutputTokens: event.reservedOutputTokens,
          usedPercent: event.usedPercent ?? 0,
          compacted: event.compacted === true,
          compactions: state.compactions,
          peakTokens: peaked ? candidate : state.context?.peakTokens,
          peakPercent: peaked
            ? (event.peakPercent ?? event.usedPercent ?? 0)
            : state.context?.peakPercent,
          pressure: event.pressure,
          action: event.action,
          strategy: event.strategy,
          verification: event.verification,
          preserved: event.preserved,
          compressed: event.compressed,
          state: event.state,
          timeline,
          ...(state.recoveries > 0 ? { recoveries: state.recoveries } : {}),
        },
      };
    }
    case "context.compaction.completed":
      return {
        ...state,
        compactions: state.compactions + 1,
        // Recorded on the compaction event rather than waiting for the next usage
        // frame, so the "before → after" figures are the ones the runtime measured
        // rather than a subtraction done here.
        lastCompaction: {
          tokensBefore: event.tokensBefore ?? 0,
          tokensAfter: event.tokensAfter ?? 0,
        },
      };
    case "context.recovery":
      return { ...state, recoveries: state.recoveries + 1 };
    default:
      return state;
  }
}

export const EMPTY_CONTEXT_STATE = {
  context: null,
  timeline: [],
  compactions: 0,
  recoveries: 0,
  lastCompaction: null,
};

/**
 * What is in the context right now, by category.
 *
 * Derived from the counts the harness sent, never from the messages on screen: the
 * console cannot see what the harness selected, and guessing would be worse than
 * saying nothing. Returns an empty list when no counts were reported, which is the
 * honest answer for a runtime that does not send them.
 */
export function contextExplanation(context) {
  const counts = context?.state;
  if (!counts) return [];
  const rows = [
    counts.goal
      ? { key: "goal", label: "Current task", value: "tracked" }
      : null,
    row("constraints", "Constraints", counts.constraints),
    row("decisions", "Decisions", counts.decisions),
    row("pending", "Pending work", counts.pending),
    row("errors", "Unresolved errors", counts.errors),
    row("questions", "Open questions", counts.questions),
    row("files", "Relevant files", counts.files),
    row("artifacts", "Artifacts", counts.artifacts),
    row("toolState", "Tool results", counts.toolState),
  ];
  return rows.filter(Boolean);
}

function row(key, label, value) {
  if (typeof value !== "number" || value <= 0) return null;
  return { key, label, value: String(value) };
}

/**
 * The before-and-after of the most recent compression, with what it protected.
 *
 * Null when nothing has been compressed, so the panel can leave the section out
 * rather than render an empty frame.
 */
export function compactionExplanation({ context, lastCompaction } = {}) {
  const action = context?.action;
  const compressive =
    action === "compaction" ||
    action === "selective-reduction" ||
    action === "reactive-compaction" ||
    action === "recovery";
  if (!compressive && !lastCompaction) return null;

  const before = lastCompaction?.tokensBefore ?? context?.peakTokens;
  const after = lastCompaction?.tokensAfter ?? context?.usedTokens;
  return {
    action: action ?? "compaction",
    label: actionLabel(action ?? "compaction"),
    tokensBefore: typeof before === "number" ? before : null,
    tokensAfter: typeof after === "number" ? after : null,
    reason: compactionReason(context),
    preserved: (context?.preserved ?? [])
      .map((key) => PRESERVED_LABELS[key] ?? key)
      .filter(Boolean),
    compressed: (context?.compressed ?? [])
      .map((key) => COMPRESSED_LABELS[key] ?? key)
      .filter(Boolean),
    verification: context?.verification ?? null,
    fallbackUsed: context?.strategy === "deterministic",
  };
}

function compactionReason(context) {
  if (context?.action === "reactive-compaction") {
    return "The model rejected the request as too long";
  }
  if (context?.action === "recovery")
    return "Important detail was missing after compression";
  if (context?.action === "tool-result-trimming")
    return "A single tool result was oversized";
  if (typeof context?.usedPercent === "number" && context?.peakPercent) {
    return `The context reached ${Math.round(context.peakPercent)}% of its budget`;
  }
  return "The configured threshold was reached";
}

/**
 * The timeline, collapsed to the turns worth showing.
 *
 * A run of quiet turns says nothing a reader needs, so only turns where something
 * happened are kept, plus the newest reading so the list ends where the meter does.
 * That is a presentation choice, not a decision about context — the full series is
 * still in `timeline`.
 */
export function contextTimeline(timeline = [], { limit = 8 } = {}) {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  const interesting = timeline.filter(
    (entry) => (entry.action && entry.action !== "none") || entry.compacted,
  );
  const newest = timeline[timeline.length - 1];
  const rows = interesting.includes(newest)
    ? interesting
    : [...interesting, newest];
  return rows.slice(-limit).map((entry) => ({
    turn: entry.turn ?? null,
    percent: Math.min(100, Math.max(0, Math.round(entry.usedPercent ?? 0))),
    action: entry.action ?? "none",
    label: actionLabel(entry.action ?? "none") ?? "No action needed",
    compacted: entry.compacted === true,
  }));
}

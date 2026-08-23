/**
 * The console's half of the context inspector.
 *
 * The harness decides; this module only accumulates and names. So these tests are
 * about faithfulness rather than logic: does a stream of events produce the reading
 * the runtime reported, does a reopened chat show the same explanation the live view
 * did, and does a runtime that reports none of this still render a working meter.
 *
 * Plain `node --test` against a dependency-free module: the shaping is where the bugs
 * would be, and asserting on it directly beats asserting on a rendered tree.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  actionDetail,
  actionLabel,
  applyContextEvent,
  compactionExplanation,
  contextExplanation,
  contextTimeline,
  EMPTY_CONTEXT_STATE,
  TIMELINE_LIMIT,
} from "../src/lib/context-inspector.js";

function usage(overrides = {}) {
  return {
    type: "context.usage",
    turn: 1,
    usedTokens: 40_000,
    budgetTokens: 190_000,
    contextWindow: 200_000,
    reservedOutputTokens: 8_192,
    usedPercent: 21,
    compacted: false,
    action: "none",
    strategy: "passthrough",
    verification: "passed",
    preserved: ["goal", "constraints", "budget"],
    state: {
      goal: true,
      constraints: 2,
      decisions: 1,
      pending: 0,
      errors: 1,
      questions: 0,
      files: 3,
      artifacts: 0,
      toolState: 2,
    },
    ...overrides,
  };
}

function fold(events, initial = EMPTY_CONTEXT_STATE) {
  return events.reduce((state, event) => applyContextEvent(state, event), initial);
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

test("a usage event becomes the current reading", () => {
  const state = fold([usage()]);

  assert.equal(state.context.usedTokens, 40_000);
  assert.equal(state.context.usedPercent, 21);
  assert.equal(state.context.action, "none");
  assert.equal(state.context.verification, "passed");
  assert.deepEqual(state.context.preserved, ["goal", "constraints", "budget"]);
});

test("the newest reading wins but the peak is a high water mark", () => {
  const state = fold([
    usage({ turn: 24, usedTokens: 180_000, usedPercent: 94, action: "none" }),
    { type: "context.compaction.completed", tokensBefore: 180_000, tokensAfter: 55_000 },
    usage({
      turn: 25,
      usedTokens: 55_000,
      usedPercent: 29,
      compacted: true,
      action: "compaction",
      peakTokens: 180_000,
      peakPercent: 94,
    }),
  ]);

  // The meter shows where the context stands now…
  assert.equal(state.context.usedPercent, 29);
  // …and still knows what it was, which is the only way the drop is explicable.
  assert.equal(state.context.peakTokens, 180_000);
  assert.equal(state.context.peakPercent, 94);
  assert.equal(state.compactions, 1);
  assert.deepEqual(state.lastCompaction, { tokensBefore: 180_000, tokensAfter: 55_000 });
});

test("a recovery event is counted", () => {
  const state = fold([
    { type: "context.recovery", restored: ["constraints"], issues: ["missing-constraints"] },
    usage({ action: "recovery", verification: "recovered" }),
  ]);

  assert.equal(state.recoveries, 1);
  assert.equal(state.context.recoveries, 1);
  assert.equal(state.context.verification, "recovered");
});

test("an event that says nothing about context leaves the state alone", () => {
  const before = fold([usage()]);
  const after = applyContextEvent(before, { type: "assistant.text.delta", delta: "hi" });
  assert.equal(after, before, "reference identity is what lets a caller skip a render");
});

test("a runtime that reports no action still produces a usable reading", () => {
  // Exactly the event an older runtime, or a custom context manager, emits.
  const state = fold([
    {
      type: "context.usage",
      usedTokens: 1_000,
      budgetTokens: 100_000,
      usedPercent: 1,
      compacted: false,
    },
  ]);

  assert.equal(state.context.usedPercent, 1);
  assert.equal(state.context.action, undefined);
  assert.equal(state.timeline.length, 0, "no action and no turn means nothing to plot");
  assert.deepEqual(contextExplanation(state.context), []);
  assert.equal(compactionExplanation({ context: state.context }), null);
});

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

test("the timeline records a turn per measurement and keeps a bounded tail", () => {
  const events = [];
  for (let turn = 1; turn <= TIMELINE_LIMIT + 12; turn += 1) {
    events.push(usage({ turn, usedPercent: turn }));
  }
  const state = fold(events);

  assert.equal(state.timeline.length, TIMELINE_LIMIT);
  assert.equal(state.timeline[state.timeline.length - 1].turn, TIMELINE_LIMIT + 12);
});

test("the timeline shown collapses quiet turns and ends on the newest reading", () => {
  const state = fold([
    usage({ turn: 12, usedPercent: 61, action: "none" }),
    usage({ turn: 18, usedPercent: 73, action: "tool-result-trimming" }),
    usage({ turn: 25, usedPercent: 91, action: "none" }),
    { type: "context.compaction.completed", tokensBefore: 173_000, tokensAfter: 61_000 },
    usage({ turn: 25, usedPercent: 32, action: "compaction", compacted: true }),
  ]);

  const rows = contextTimeline(state.timeline);

  assert.deepEqual(
    rows.map((row) => [row.turn, row.percent, row.action]),
    [
      [18, 73, "tool-result-trimming"],
      [25, 32, "compaction"],
    ],
  );
  assert.equal(rows[0].label, "Tool output shortened");
  assert.equal(rows[1].label, "Earlier turns summarised");
});

test("a timeline of nothing but quiet turns still shows where things stand", () => {
  const state = fold([usage({ turn: 1, usedPercent: 12 }), usage({ turn: 2, usedPercent: 14 })]);
  const rows = contextTimeline(state.timeline);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn, 2);
  assert.equal(rows[0].action, "none");
});

// ---------------------------------------------------------------------------
// The explanation
// ---------------------------------------------------------------------------

test("the explanation lists only the categories that have something in them", () => {
  const rows = contextExplanation(usage().state ? { state: usage().state } : {});

  const labels = rows.map((row) => row.label);
  assert.ok(labels.includes("Current task"));
  assert.ok(labels.includes("Constraints"));
  assert.ok(labels.includes("Unresolved errors"));
  assert.ok(labels.includes("Relevant files"));
  // Empty categories are absent rather than shown as zero: a row reading "Pending
  // work 0" is noise dressed as information.
  assert.ok(!labels.includes("Pending work"));
  assert.ok(!labels.includes("Open questions"));
});

test("every action has a label and an explanation a user can act on", () => {
  for (const action of [
    "none",
    "tool-result-trimming",
    "selective-reduction",
    "compaction",
    "reactive-compaction",
    "recovery",
  ]) {
    assert.ok(actionLabel(action), `${action} has no label`);
    assert.ok((actionDetail(action) ?? "").length > 20, `${action} has no explanation`);
  }
  assert.equal(actionLabel("something-newer-than-this-console"), null);
});

// ---------------------------------------------------------------------------
// The compaction report
// ---------------------------------------------------------------------------

test("a compaction is reported as before, after, why, kept and compressed", () => {
  const state = fold([
    usage({ turn: 25, usedPercent: 91, action: "none" }),
    { type: "context.compaction.completed", tokensBefore: 173_000, tokensAfter: 61_000 },
    usage({
      turn: 25,
      usedTokens: 61_000,
      usedPercent: 32,
      compacted: true,
      action: "compaction",
      strategy: "llm-summarization",
      peakTokens: 173_000,
      peakPercent: 91,
      preserved: ["goal", "constraints", "decisions", "pending-work", "files"],
      compressed: ["low-value-history", "tool-state"],
    }),
  ]);

  const report = compactionExplanation(state);

  assert.equal(report.label, "Earlier turns summarised");
  assert.equal(report.tokensBefore, 173_000);
  assert.equal(report.tokensAfter, 61_000);
  assert.match(report.reason, /91%/);
  assert.deepEqual(report.preserved, [
    "Current task",
    "Your constraints",
    "Decisions",
    "Pending work",
    "Relevant files",
  ]);
  assert.deepEqual(report.compressed, ["Redundant older turns", "Older tool output"]);
  assert.equal(report.fallbackUsed, false);
});

test("a deterministic summary is reported as one", () => {
  const state = fold([
    usage({ action: "compaction", strategy: "deterministic", compacted: true }),
  ]);
  assert.equal(compactionExplanation(state).fallbackUsed, true);
});

test("a provider rejection is explained as a retry, not as a threshold", () => {
  const state = fold([usage({ action: "reactive-compaction", compacted: true })]);
  const report = compactionExplanation(state);

  assert.equal(report.label, "Retried with less context");
  assert.match(report.reason, /rejected the request/i);
});

test("trimming is explained without claiming the conversation was summarised", () => {
  const state = fold([usage({ action: "tool-result-trimming", usedPercent: 84 })]);
  const report = compactionExplanation(state);

  assert.equal(report, null, "trimming is not a compression of the conversation");
  assert.equal(actionLabel("tool-result-trimming"), "Tool output shortened");
});

// ---------------------------------------------------------------------------
// A reopened chat
// ---------------------------------------------------------------------------

test("a reopened chat renders the same explanation from its stored context", () => {
  // The shape the console server writes to `chat.session.context`.
  const stored = {
    usedTokens: 61_000,
    budgetTokens: 190_000,
    contextWindow: 200_000,
    reservedOutputTokens: 8_192,
    usedPercent: 32,
    compacted: true,
    compactions: 1,
    peakTokens: 173_000,
    peakPercent: 91,
    measuredAt: "2026-08-22T10:00:00.000Z",
    pressure: "critical",
    action: "compaction",
    strategy: "llm-summarization",
    verification: "passed",
    preserved: ["goal", "constraints"],
    compressed: ["low-value-history"],
    state: { goal: true, constraints: 2, files: 3 },
    timeline: [
      { turn: 24, usedPercent: 91, action: "none" },
      { turn: 25, usedPercent: 32, action: "compaction", compacted: true },
    ],
  };

  assert.equal(actionLabel(stored.action), "Earlier turns summarised");
  assert.deepEqual(
    contextExplanation(stored).map((row) => row.label),
    ["Current task", "Constraints", "Relevant files"],
  );
  const report = compactionExplanation({ context: stored });
  assert.deepEqual(report.preserved, ["Current task", "Your constraints"]);
  // No `context.compaction.completed` to read after a reload, so the peak stands in
  // for the "before" figure rather than the section disappearing.
  assert.equal(report.tokensBefore, 173_000);
  assert.equal(report.tokensAfter, 61_000);
  assert.equal(contextTimeline(stored.timeline).length, 1);
});

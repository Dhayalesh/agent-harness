/**
 * The console server's half of the context inspector.
 *
 * `context-usage.test.js` covers the original fold: the newest reading, the peak, the
 * compaction count. This covers what the orchestration layer added — the automatic
 * action, the verification outcome, the state counts, the timeline — and the two
 * properties that matter more than any of them:
 *
 * 1. A runtime that reports none of it still produces a storable run.
 * 2. A runtime that reports more of it than this console knows about is not truncated
 *    on the way to the database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RunTotals } from "../src/services/run-totals.js";
import { runtimeResultSchema } from "../src/lib/schemas.js";

function usage(overrides = {}) {
  return {
    type: "context.usage",
    turn: 1,
    usedTokens: 120_000,
    budgetTokens: 190_000,
    contextWindow: 200_000,
    reservedOutputTokens: 8_192,
    usedPercent: 63.2,
    compacted: false,
    pressure: "nominal",
    action: "none",
    strategy: "passthrough",
    verification: "passed",
    preserved: ["goal", "constraints", "budget"],
    state: {
      goal: true,
      constraints: 2,
      decisions: 1,
      supersededDecisions: 1,
      pending: 1,
      completed: 3,
      questions: 0,
      errors: 1,
      files: 4,
      artifacts: 0,
      toolState: 2,
    },
    ...overrides,
  };
}

function fold(events) {
  const totals = new RunTotals();
  totals.observe({ type: "session.started", sessionId: "s1" });
  for (const event of events) totals.observe(event);
  totals.observe({ type: "session.completed", reason: "end_turn" });
  return totals.result({
    agentName: "context-agent",
    durationMs: 1_000,
    runtimeSessionId: "s1",
  });
}

test("the stored context carries the automatic action and the verification outcome", () => {
  const result = fold([usage({ action: "tool-result-trimming", verification: "passed" })]);

  assert.equal(result.context.action, "tool-result-trimming");
  assert.equal(result.context.verification, "passed");
  assert.equal(result.context.strategy, "passthrough");
  assert.deepEqual(result.context.preserved, ["goal", "constraints", "budget"]);
  assert.equal(result.context.state.constraints, 2);
  assert.equal(result.context.state.supersededDecisions, 1);
});

test("the timeline records every measured turn and keeps the newest forty", () => {
  const events = [];
  for (let turn = 1; turn <= 52; turn += 1) {
    events.push(usage({ turn, usedPercent: turn }));
  }
  const result = fold(events);

  assert.equal(result.context.timeline.length, 40);
  assert.equal(result.context.timeline[0].turn, 13);
  assert.equal(result.context.timeline[39].turn, 52);
});

test("a compaction turn is visible in the timeline after the meter has fallen", () => {
  const result = fold([
    usage({ turn: 12, usedPercent: 61, action: "none" }),
    usage({ turn: 18, usedPercent: 73, action: "tool-result-trimming" }),
    usage({ turn: 25, usedPercent: 91, action: "none" }),
    {
      type: "context.compaction.started",
      estimatedTokens: 173_000,
    },
    {
      type: "context.compaction.completed",
      tokensBefore: 173_000,
      tokensAfter: 61_000,
    },
    usage({
      turn: 25,
      usedTokens: 61_000,
      usedPercent: 32,
      compacted: true,
      action: "compaction",
      strategy: "llm-summarization",
      peakTokens: 173_000,
      peakPercent: 91,
      compressed: ["low-value-history"],
    }),
  ]);

  // Where it stands now…
  assert.equal(result.context.usedPercent, 32);
  // …why it moved…
  assert.equal(result.context.peakPercent, 91);
  assert.equal(result.context.compactions, 1);
  // …and the sequence that got it there.
  assert.deepEqual(
    result.context.timeline.map((entry) => [entry.turn, entry.usedPercent, entry.action]),
    [
      [12, 61, "none"],
      [18, 73, "tool-result-trimming"],
      [25, 91, "none"],
      [25, 32, "compaction"],
    ],
  );
  assert.deepEqual(result.context.compressed, ["low-value-history"]);
});

test("a recovery is counted so a reader can see the layer had to correct itself", () => {
  const result = fold([
    {
      type: "context.recovery",
      restored: ["constraints"],
      issues: ["missing-constraints"],
      tokensBefore: 173_000,
      tokensAfter: 70_000,
    },
    usage({ action: "recovery", verification: "recovered", compacted: true }),
  ]);

  assert.equal(result.context.recoveries, 1);
  assert.equal(result.context.verification, "recovered");
});

test("a runtime that reports no orchestration detail still stores a usable context", () => {
  const totals = new RunTotals();
  totals.observe({ type: "session.started", sessionId: "s2" });
  // The exact event an older runtime emits: no turn, no action, no state.
  totals.observe({
    type: "context.usage",
    usedTokens: 1_000,
    budgetTokens: 100_000,
    usedPercent: 1,
    compacted: false,
  });
  totals.observe({ type: "session.completed", reason: "end_turn" });

  const result = totals.result({
    agentName: "context-agent",
    durationMs: 10,
    runtimeSessionId: "s2",
  });

  assert.equal(result.context.usedTokens, 1_000);
  assert.equal(result.context.usedPercent, 1);
  assert.equal("action" in result.context, false);
  assert.equal("timeline" in result.context, false);
  assert.equal("state" in result.context, false);
});

test("context.selection and context.verification do not disturb the rest of the fold", () => {
  const result = fold([
    { type: "assistant.text.delta", delta: "working" },
    {
      type: "context.selection",
      kept: 40,
      dropped: 12,
      trimmedToolResults: 2,
      deduplicatedToolResults: 1,
      compressed: ["low-value-history"],
    },
    {
      type: "context.verification",
      passed: true,
      preserved: ["goal", "constraints"],
    },
    usage({ action: "selective-reduction", compacted: true }),
  ]);

  assert.equal(result.output, "working");
  assert.equal(result.context.action, "selective-reduction");
  assert.equal(result.status, "success");
});

test("the runtime result schema accepts the whole inspector block and tolerates its absence", () => {
  const base = {
    status: "success",
    sessionId: "s3",
    agentName: "context-agent",
    session: {
      mode: "persistent",
      resumed: false,
      origin: "new",
      historyMessageCount: 2,
    },
    output: "done",
    messages: [],
    workingDirectory: "/tmp/run",
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 4 },
    tools: [],
    durationMs: 90,
  };

  assert.equal(runtimeResultSchema.safeParse(base).success, true);

  const full = runtimeResultSchema.safeParse({
    ...base,
    context: {
      usedTokens: 61_000,
      budgetTokens: 190_000,
      contextWindow: 200_000,
      reservedOutputTokens: 8_192,
      usedPercent: 32,
      compacted: true,
      compactions: 1,
      peakTokens: 173_000,
      peakPercent: 91,
      pressure: "critical",
      action: "compaction",
      strategy: "llm-summarization",
      verification: "passed",
      preserved: ["goal", "constraints"],
      compressed: ["low-value-history"],
      recoveries: 0,
      state: { goal: true, constraints: 2, files: 4 },
      timeline: [
        { turn: 24, usedPercent: 91, action: "none" },
        { turn: 25, usedPercent: 32, action: "compaction", compacted: true },
      ],
    },
  });
  assert.equal(full.success, true);
  assert.equal(full.data.context.action, "compaction");
  assert.equal(full.data.context.timeline.length, 2);

  // A field this console has not learned about is carried rather than rejected: a run
  // must not fail to be stored because the runtime got a new capability.
  const newer = runtimeResultSchema.safeParse({
    ...base,
    context: {
      usedTokens: 1,
      budgetTokens: 2,
      usedPercent: 50,
      somethingNewerThanThisConsole: { nested: true },
    },
  });
  assert.equal(newer.success, true);
  assert.deepEqual(newer.data.context.somethingNewerThanThisConsole, { nested: true });

  // An action name outside the known set is refused, because that one *is* a
  // vocabulary the client switches on.
  assert.equal(
    runtimeResultSchema.safeParse({
      ...base,
      context: { usedTokens: 1, budgetTokens: 2, usedPercent: 1, action: "improvised" },
    }).success,
    false,
  );
});

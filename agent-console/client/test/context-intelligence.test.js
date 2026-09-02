import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptationState,
  budgetRows,
  executionState,
  groundingState,
  issueSummary,
  provenanceState,
  qualityPresentation,
  qualityScore,
  reportStats,
  runtimeAttempts,
  runtimeValue,
} from "../src/lib/context-intelligence.js";

const report = {
  quality: {
    status: "degraded",
    score: 0.824,
    issues: [
      { code: "stale", severity: "warning", remediation: "replace", items: 2 },
      { code: "stale", severity: "warning", remediation: "replace", items: 1 },
    ],
  },
  budget: {
    usedInput: 20_000,
    availableInput: 100_000,
    allocations: [
      {
        category: "retrievalEvidence",
        usedTokens: 12_000,
        maximumTokens: 24_000,
      },
    ],
  },
  finalContext: { evidence: 6, sources: 3 },
  retrieval: { results: 8, iterations: 2 },
  capabilities: { selected: 4, available: 20 },
};

test("presents quality and budget decisions from runtime values", () => {
  assert.deepEqual(qualityPresentation(report), {
    label: "Context degraded",
    color: "warning",
    detail: "The run continued with one or more context quality warnings.",
  });
  assert.equal(qualityScore(report), 82);
  assert.deepEqual(budgetRows(report), [
    {
      category: "retrievalEvidence",
      usedTokens: 12_000,
      maximumTokens: 24_000,
      label: "Retrieved evidence",
      percent: 50,
    },
  ]);
  assert.deepEqual(
    reportStats(report).map((entry) => entry.value),
    ["20.0k", "6", "8", "4"],
  );
});

test("coalesces repeated quality issue codes for a compact UI", () => {
  assert.deepEqual(issueSummary(report), [
    {
      code: "stale",
      label: "Stale",
      severity: "warning",
      remediation: "replace",
      items: 3,
      occurrences: 2,
    },
  ]);
});

test("preserves runtime attempt, adaptation, provenance, and grounding failure states verbatim", () => {
  const traceReport = {
    retrieval: {
      attempts: [
        {
          attemptId: "attempt-1",
          retrievalPlanId: "plan-1",
          attemptNumber: 1,
          executionState: "NOT_EXECUTED",
          strategy: "INITIAL",
        },
      ],
      adaptive: { triggered: false },
    },
    trace: { provenance: { status: "PARTIAL", stages: [] } },
    grounding: { status: "FAIL" },
  };

  assert.equal(runtimeAttempts(traceReport).length, 1);
  assert.equal(
    executionState(runtimeAttempts(traceReport)[0].executionState),
    "NOT_EXECUTED",
  );
  assert.equal(
    runtimeValue(runtimeAttempts(traceReport)[0].actualToolInput),
    "NOT EXPOSED",
  );
  assert.equal(adaptationState(traceReport), "NOT TRIGGERED");
  assert.equal(provenanceState(traceReport), "PARTIAL");
  assert.equal(groundingState(traceReport), "FAIL");
  assert.notEqual(executionState("NOT_EXECUTED"), "SUCCESS");
});

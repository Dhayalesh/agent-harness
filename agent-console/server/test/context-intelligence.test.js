import assert from "node:assert/strict";
import test from "node:test";
import { contextIntelligenceReportSchema } from "../src/lib/schemas.js";
import { RunTotals } from "../src/services/run-totals.js";

function report(overrides = {}) {
  return {
    version: 1,
    requestId: "request-1",
    intent: {
      operation: "analyze",
      complexity: "compound",
      confidence: 0.92,
      constraints: 2,
      requiredEntities: 1,
      ambiguities: 0,
    },
    query: { variants: 2, transformations: { original: 1, subquery: 1 } },
    retrieval: {
      providers: ["documents"],
      providerCount: 1,
      iterations: 1,
      results: 4,
      sufficient: true,
      insufficiencies: 0,
      conflicts: 0,
    },
    memory: { recalled: 2, types: { working: 2 } },
    capabilities: {
      available: 12,
      selected: 3,
      excluded: 9,
      names: ["read_file", "grep", "context_artifact_read"],
    },
    observations: {
      total: 1,
      outcomes: { success: 1 },
      facts: 3,
      identifiers: 1,
      followUps: 0,
      offloaded: 0,
    },
    task: {
      status: "active",
      steps: 2,
      completed: 1,
      pending: 1,
      retries: 0,
      unresolvedIssues: 0,
      pendingDecisions: 0,
    },
    quality: {
      status: "passed",
      score: 0.96,
      sufficient: true,
      conflicts: 0,
      issues: [],
    },
    budget: {
      inputLimit: 128_000,
      outputReservation: 8_192,
      safetyMargin: 2_000,
      availableInput: 117_808,
      usedInput: 16_200,
      allocations: [
        {
          category: "conversationHistory",
          maximumTokens: 40_000,
          usedTokens: 8_000,
          priority: 5,
        },
      ],
      exceeded: false,
    },
    finalContext: {
      items: 8,
      evidence: 4,
      sources: 2,
      sections: 5,
      tools: 3,
      omittedItems: 2,
      offloadedArtifacts: 0,
      provenanceRecords: 8,
    },
    reasoning: { mode: "react", alternatives: 0, planSteps: 2 },
    updatedAt: "2026-08-31T08:00:00.000Z",
    ...overrides,
  };
}

test("validates the bounded Context Intelligence wire report", () => {
  const parsed = contextIntelligenceReportSchema.safeParse(report());
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.quality.status, "passed");

  assert.equal(
    contextIntelligenceReportSchema.safeParse(
      report({
        quality: {
          status: "passed",
          score: 2,
          sufficient: true,
          conflicts: 0,
          issues: [],
        },
      }),
    ).success,
    false,
  );
});

test("stream totals retain the final Context Intelligence report", () => {
  const totals = new RunTotals();
  totals.observe({ type: "session.started", sessionId: "session-1" });
  totals.observe({
    type: "context.intelligence",
    report: report({ requestId: "first" }),
  });
  totals.observe({
    type: "context.intelligence",
    report: report({ requestId: "final" }),
  });
  totals.observe({ type: "session.completed", reason: "end_turn" });

  const result = totals.result({
    agentName: "context-agent",
    durationMs: 100,
    runtimeSessionId: "session-1",
  });
  assert.equal(result.contextIntelligence.requestId, "final");
  assert.equal(result.contextIntelligence.budget.usedInput, 16_200);
});

test("stream totals ignore a malformed report instead of persisting it", () => {
  const totals = new RunTotals();
  totals.observe({ type: "session.started", sessionId: "session-1" });
  totals.observe({
    type: "context.intelligence",
    report: { rawRequest: "do not store" },
  });
  totals.observe({ type: "session.completed", reason: "end_turn" });

  const result = totals.result({
    agentName: "context-agent",
    durationMs: 100,
    runtimeSessionId: "session-1",
  });
  assert.equal(result.contextIntelligence, undefined);
});

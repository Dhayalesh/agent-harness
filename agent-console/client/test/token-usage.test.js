import assert from "node:assert/strict";
import test from "node:test";
import {
  addTokenUsage,
  tokenTotal,
  upsertUsageDetail,
  usageForTool,
} from "../src/lib/token-usage.js";

test("adds model usage while keeping subset counters out of the total", () => {
  const usage = addTokenUsage(
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
    { inputTokens: 40, outputTokens: 8, reasoningTokens: 3 },
  );

  assert.deepEqual(usage, {
    inputTokens: 140,
    outputTokens: 28,
    cacheReadTokens: 60,
    reasoningTokens: 3,
    totalTokens: 168,
  });
  assert.equal(tokenTotal(usage), 168);
});

test("correlates a shared model-step reading with every requested tool", () => {
  let details = upsertUsageDetail([], {
    turnId: "turn-1",
    turn: 1,
    toolCallId: "call-1",
  });
  details = upsertUsageDetail(details, {
    turnId: "turn-1",
    toolCallId: "call-2",
  });
  details = upsertUsageDetail(details, {
    turnId: "turn-1",
    usage: { inputTokens: 90, outputTokens: 10 },
  });

  assert.deepEqual(usageForTool({ id: "call-2", turnId: "turn-1" }, details), {
    usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
    turn: 1,
    sharedAcross: 2,
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrateRuntimeReasoning,
  reasoningFromMessages,
} from "../src/services/response-reasoning.js";

test("keeps reasoning from every model pass in the current user turn", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "old request" }],
    },
    {
      role: "assistant",
      reasoning: "Old reasoning",
      content: [{ type: "text", text: "old answer" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "new request" }],
    },
    {
      role: "assistant",
      reasoning: "First, inspect the source.",
      content: [{ type: "tool_call", id: "call-1", name: "read_file" }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "call-1" }],
    },
    {
      role: "assistant",
      reasoning: "The source confirms the expected path.",
      content: [{ type: "text", text: "done" }],
    },
  ];

  assert.equal(
    reasoningFromMessages(messages),
    "First, inspect the source.\n\nThe source confirms the expected path.",
  );
  assert.equal(
    hydrateRuntimeReasoning({ messages }).reasoning,
    "First, inspect the source.\n\nThe source confirms the expected path.",
  );
});

test("does not add an empty reasoning field", () => {
  const result = hydrateRuntimeReasoning({ messages: [] });
  assert.equal(Object.hasOwn(result, "reasoning"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantTextFromMessages,
  hydrateRuntimeText,
} from "../src/services/response-text.js";

test("recovers current-turn assistant narrative for a file response", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "old" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Old answer" }],
    },
    { role: "user", content: [{ type: "text", text: "make docs" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "doc", name: "create_markdown_artifact" },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolCallId: "doc" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "I created both requested documents." }],
    },
  ];

  assert.equal(
    assistantTextFromMessages(messages),
    "I created both requested documents.",
  );
  assert.equal(
    hydrateRuntimeText({ output: "", messages }).output,
    "I created both requested documents.",
  );
});

test("prefers the runtime output when it is already present", () => {
  const result = hydrateRuntimeText({
    output: "Canonical response",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "Fallback" }] },
    ],
  });
  assert.equal(result.output, "Canonical response");
});

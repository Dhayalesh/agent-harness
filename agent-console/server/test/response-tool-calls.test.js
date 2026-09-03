import assert from "node:assert/strict";
import test from "node:test";
import { hydrateRuntimeToolCalls } from "../src/services/response-tool-calls.js";

test("keeps only current-turn tool history and correlates results", () => {
  const result = hydrateRuntimeToolCalls({
    messages: [
      { role: "user", content: [{ type: "text", text: "old" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "old-call", name: "grep", input: "old" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "current" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: "file contents",
            isError: false,
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.toolCalls, [
    {
      id: "call-1",
      name: "read_file",
      input: '{\n  "path": "README.md"\n}',
      output: "file contents",
      status: "done",
    },
  ]);
});

test("adds buffered model-step usage to every correlated tool call", () => {
  const result = hydrateRuntimeToolCalls({
    messages: [
      { role: "user", content: [{ type: "text", text: "inspect" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "read_file", input: {} },
          { type: "tool_call", id: "call-2", name: "grep", input: {} },
        ],
      },
    ],
    usageDetails: [
      {
        turnId: "turn-1",
        turn: 1,
        toolCallIds: ["call-1", "call-2"],
        usage: { inputTokens: 80, outputTokens: 12 },
      },
    ],
  });

  assert.deepEqual(result.toolCalls[1].usage, {
    inputTokens: 80,
    outputTokens: 12,
    totalTokens: 92,
  });
  assert.equal(result.toolCalls[1].usageTurn, 1);
  assert.equal(result.toolCalls[1].usageSharedAcross, 2);
});

test("does not duplicate generated Markdown in persisted tool history", () => {
  const result = hydrateRuntimeToolCalls({
    messages: [
      { role: "user", content: [{ type: "text", text: "make a doc" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "doc-call",
            name: "create_markdown_artifact",
            input: {
              title: "Plan",
              filename: "plan.md",
              content: "# secret body",
            },
          },
        ],
      },
    ],
  });

  assert.doesNotMatch(result.toolCalls[0].input, /secret body/);
  assert.match(result.toolCalls[0].input, /saved as Markdown artifact/);
});

test("summarizes generated spreadsheet rows instead of persisting cell data", () => {
  const result = hydrateRuntimeToolCalls({
    messages: [
      { role: "user", content: [{ type: "text", text: "make a workbook" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "sheet-call",
            name: "create_spreadsheet_artifact",
            input: {
              title: "Accounts",
              filename: "accounts.xlsx",
              sheets: [
                {
                  name: "Q1",
                  columns: ["Name", "Value"],
                  rows: [["secret", 42]],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.doesNotMatch(result.toolCalls[0].input, /secret/);
  assert.match(result.toolCalls[0].input, /"rows": 1/);
  assert.match(result.toolCalls[0].input, /accounts\.xlsx/);
});

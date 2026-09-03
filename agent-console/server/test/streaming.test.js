import assert from "node:assert/strict";
import test from "node:test";
import { readEventStream } from "../src/services/agentcore.js";
import { RunTotals } from "../src/services/run-totals.js";

/** Feeds the reader byte groups that do not line up with frame boundaries. */
async function* chunks(...parts) {
  for (const part of parts) yield Buffer.from(part, "utf8");
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("frames are reassembled across chunk boundaries", async () => {
  const events = await collect(
    readEventStream(
      chunks(
        'event: assistant.text.delta\ndata: {"type":"assistant.text.d',
        'elta","delta":"Hel"}\n\nevent: assistant.text.delta\ndata: ',
        '{"type":"assistant.text.delta","delta":"lo"}\n\n',
      ),
    ),
  );

  assert.deepEqual(events, [
    { type: "assistant.text.delta", delta: "Hel" },
    { type: "assistant.text.delta", delta: "lo" },
  ]);
});

test("keep-alive comments and CRLF framing are tolerated", async () => {
  const events = await collect(
    readEventStream(
      chunks(
        ": keep-alive\r\n\r\n",
        'event: session.completed\r\ndata: {"type":"session.completed","reason":"end_turn"}\r\n\r\n',
        ": keep-alive\n\n",
      ),
    ),
  );

  assert.deepEqual(events, [{ type: "session.completed", reason: "end_turn" }]);
});

test("a bare error frame becomes an error event rather than an unreadable object", async () => {
  const events = await collect(
    readEventStream(
      chunks('event: error\ndata: {"error":"the runtime gave up"}\n\n'),
    ),
  );

  assert.deepEqual(events, [
    {
      type: "error",
      code: "RUNTIME_STREAM_FAILED",
      message: "the runtime gave up",
      recoverable: false,
    },
  ]);
});

test("a final frame with no trailing blank line is still delivered", async () => {
  const events = await collect(
    readEventStream(chunks('data: {"type":"usage.updated","usage":{}}')),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "usage.updated");
});

test("folding a stream produces the same result shape the buffered path returns", () => {
  const totals = new RunTotals();
  const stream = [
    {
      type: "session.started",
      sessionId: "harness-session",
      mode: "persistent",
      storage: "s3",
      resumed: true,
      origin: "store",
      historyMessageCount: 4,
    },
    { type: "assistant.reasoning.delta", delta: "Weighing " },
    { type: "assistant.reasoning.delta", delta: "the options." },
    { type: "assistant.text.delta", delta: "Hello " },
    {
      type: "tool.requested",
      call: { id: "call-1", name: "read_file", input: {} },
    },
    {
      type: "tool.completed",
      result: { toolCallId: "call-1", isError: false },
    },
    { type: "tool.requested", call: { id: "call-2", name: "bash", input: {} } },
    { type: "tool.completed", result: { toolCallId: "call-2", isError: true } },
    { type: "usage.updated", usage: { inputTokens: 100, outputTokens: 20 } },
    { type: "usage.updated", usage: { inputTokens: 50, outputTokens: 5 } },
    { type: "assistant.text.delta", delta: "there." },
    {
      type: "assistant.message.completed",
      message: {
        reasoning: "Weighing the options.",
        content: [{ type: "text", text: "Hello there." }],
      },
    },
    { type: "turn.completed", turn: 2, reason: "end_turn" },
    { type: "session.completed", reason: "end_turn" },
  ];
  for (const event of stream) totals.observe(event);

  const result = totals.result({
    agentName: "reviewer",
    durationMs: 4321,
    runtimeSessionId: "runtime-session",
  });

  assert.equal(result.status, "success");
  assert.equal(result.output, "Hello there.");
  assert.equal(result.reasoning, "Weighing the options.");
  assert.equal(result.sessionId, "harness-session");
  assert.equal(result.session.storage, "s3");
  assert.equal(result.turns, 2);
  assert.equal(result.stopReason, "end_turn");
  // Usage is additive across updates, as the harness reports it.
  assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 25 });
  assert.deepEqual(result.tools, [
    { name: "read_file", calls: 1, errors: 0 },
    { name: "bash", calls: 1, errors: 1 },
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.durationMs, 4321);
});

test("attributes each usage reading to its model step and related tool calls", () => {
  const totals = new RunTotals();
  for (const event of [
    { type: "turn.started", turnId: "turn-tools", turn: 1 },
    {
      type: "tool.requested",
      turnId: "turn-tools",
      call: { id: "call-1", name: "read_file", input: {} },
    },
    {
      type: "tool.requested",
      turnId: "turn-tools",
      call: { id: "call-2", name: "grep", input: {} },
    },
    {
      type: "usage.updated",
      turnId: "turn-tools",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
    },
    { type: "turn.started", turnId: "turn-answer", turn: 2 },
    {
      type: "usage.updated",
      turnId: "turn-answer",
      usage: { inputTokens: 125, outputTokens: 30, reasoningTokens: 8 },
    },
    {
      type: "turn.completed",
      turnId: "turn-answer",
      turn: 2,
      reason: "end_turn",
    },
    { type: "session.completed", reason: "end_turn" },
  ]) {
    totals.observe(event);
  }

  const result = totals.result({ agentName: "a", durationMs: 1 });
  assert.deepEqual(result.usage, {
    inputTokens: 225,
    outputTokens: 50,
    cacheReadTokens: 60,
    reasoningTokens: 8,
  });
  assert.deepEqual(result.usageDetails, [
    {
      turnId: "turn-tools",
      turn: 1,
      toolCallIds: ["call-1", "call-2"],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
    },
    {
      turnId: "turn-answer",
      turn: 2,
      toolCallIds: [],
      usage: { inputTokens: 125, outputTokens: 30, reasoningTokens: 8 },
    },
  ]);
  assert.deepEqual(result.toolCalls[0].usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 60,
    totalTokens: 120,
  });
  assert.equal(result.toolCalls[0].usageSharedAcross, 2);
  assert.equal(result.toolCalls[1].usageSharedAcross, 2);
});

test("a reported error and a truncated stream both fold to a failed run", () => {
  const failed = new RunTotals();
  failed.observe({ type: "assistant.text.delta", delta: "Partial" });
  failed.observe({
    type: "error",
    code: "MODEL_ERROR",
    message: "upstream refused",
    recoverable: false,
  });
  failed.observe({ type: "session.completed", reason: "model_error" });
  const reported = failed.result({ agentName: "a", durationMs: 1 });
  assert.equal(reported.status, "error");
  assert.equal(reported.error.code, "MODEL_ERROR");
  // The partial answer is kept: the run spent those tokens.
  assert.equal(reported.output, "Partial");

  // No terminal event at all means the stream was cut, which no error event says.
  const truncated = new RunTotals();
  truncated.observe({ type: "assistant.text.delta", delta: "Half" });
  const cut = truncated.result({ agentName: "a", durationMs: 1 });
  assert.equal(cut.status, "error");
  assert.equal(cut.error.code, "RUNTIME_STREAM_INCOMPLETE");
  assert.equal(cut.error.recoverable, true);
  assert.equal(cut.output, "Half");
});

test("a streamed Markdown artifact becomes a file response with an S3 reference", () => {
  const totals = new RunTotals();
  totals.observe({
    type: "tool.requested",
    call: {
      id: "call-doc",
      name: "create_markdown_artifact",
      input: {
        title: "Technical design",
        filename: "technical-design.md",
        content: "# Technical design\n\nDetails.",
      },
    },
  });
  totals.observe({
    type: "artifact.created",
    toolCallId: "call-doc",
    artifact: {
      id: "artifact-stream",
      contentType: "text/markdown; charset=utf-8",
      size: 29,
      createdAt: "2026-08-14T00:00:00.000Z",
      metadata: { filename: "technical-design.md", title: "Technical design" },
      storage: {
        kind: "s3",
        bucket: "private-agent-artifacts",
        key: "production/artifacts/artifact-stream.md",
      },
    },
  });
  totals.observe({
    type: "assistant.message.completed",
    message: {
      reasoning: "The requested technical design is ready.",
      content: [
        {
          type: "text",
          text: "I created the technical design and attached it below.",
        },
      ],
    },
  });
  totals.observe({ type: "session.completed", reason: "end_turn" });

  const result = totals.result({
    agentName: "writer",
    durationMs: 10,
    runtimeSessionId: "runtime-session",
  });
  assert.equal(
    result.output,
    "I created the technical design and attached it below.",
  );
  assert.equal(result.reasoning, "The requested technical design is ready.");
  assert.equal(result.response.type, "files");
  assert.equal(Object.hasOwn(result.artifacts[0], "content"), false);
  assert.deepEqual(result.artifacts[0].storage, {
    kind: "s3",
    bucket: "private-agent-artifacts",
    key: "production/artifacts/artifact-stream.md",
  });
  assert.deepEqual(result.toolCalls, [
    {
      id: "call-doc",
      name: "create_markdown_artifact",
      input:
        '{\n  "title": "Technical design",\n  "filename": "technical-design.md",\n  "content": "[saved as Markdown artifact]"\n}',
      output: "",
      status: "pending",
    },
  ]);
});

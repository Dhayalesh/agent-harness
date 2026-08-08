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
    readEventStream(chunks('event: error\ndata: {"error":"the runtime gave up"}\n\n')),
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
    { type: "session.started", sessionId: "harness-session" },
    { type: "assistant.reasoning.delta", delta: "Weighing " },
    { type: "assistant.reasoning.delta", delta: "the options." },
    { type: "assistant.text.delta", delta: "Hello " },
    {
      type: "tool.requested",
      call: { id: "call-1", name: "read_file", input: {} },
    },
    { type: "tool.completed", result: { toolCallId: "call-1", isError: false } },
    { type: "tool.requested", call: { id: "call-2", name: "bash", input: {} } },
    { type: "tool.completed", result: { toolCallId: "call-2", isError: true } },
    { type: "usage.updated", usage: { inputTokens: 100, outputTokens: 20 } },
    { type: "usage.updated", usage: { inputTokens: 50, outputTokens: 5 } },
    { type: "assistant.text.delta", delta: "there." },
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

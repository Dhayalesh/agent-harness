import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionHistory,
  performChatContextCompaction,
} from "../src/routes/chats.js";

const at = "2026-08-10T00:00:00.000Z";
const message = (id, role, content) => ({ id, role, content, createdAt: at });

test("builds typed recovery history and excludes errors", () => {
  assert.deepEqual(
    buildSessionHistory([
      message("u1", "user", "Find authentication."),
      message("e1", "error", "transient secret failure"),
      message("a1", "assistant", "It is in src/auth.js."),
    ]),
    [
      message("u1", "user", "Find authentication."),
      message("a1", "assistant", "It is in src/auth.js."),
    ],
  );
});

test("starts recovery at the most recent context reset", () => {
  const history = buildSessionHistory(
    [
      message("u1", "user", "old context"),
      message("a1", "assistant", "old answer"),
      message("u2", "user", "new context"),
    ],
    2,
  );
  assert.deepEqual(
    history.map(({ id }) => id),
    ["u2"],
  );
});

test("bounds recovery by characters and message count while favoring recent turns", () => {
  const history = buildSessionHistory(
    [
      message("old", "user", "x".repeat(100)),
      message("a1", "assistant", "recent answer"),
      message("u2", "user", "recent question"),
    ],
    0,
    40,
    2,
  );
  assert.deepEqual(
    history.map(({ id }) => id),
    ["a1", "u2"],
  );
  assert.ok(
    history.reduce((size, entry) => size + entry.content.length, 0) <= 40,
  );
});

test("immediate compaction leases the same session and never writes transcript messages", async () => {
  const updates = [];
  const existing = {
    _id: { toString: () => "chat-1" },
    agentId: "agent-1",
    runtimeSessionId: "runtime-session-1",
    session: { status: "active", historyStartIndex: 0 },
    messages: [
      message("u1", "user", "Keep this goal"),
      message("a1", "assistant", "Current answer"),
    ],
  };
  const leased = {
    ...existing,
    session: { ...existing.session, status: "running", activeRequestId: "lease-1" },
  };
  const completed = {
    ...existing,
    session: { ...existing.session, context: { usedPercent: 24 } },
  };
  const chatModel = {
    async findOneAndUpdate(filter, update) {
      updates.push({ filter, update });
      return updates.length === 1 ? leased : completed;
    },
  };
  let invocationInput;
  const result = await performChatContextCompaction(existing, { name: "Agent" }, {
    chatModel,
    requestId: "lease-1",
    timestamp: "2026-08-23T12:00:00.000Z",
    resolveContextWindow: async () => 200_000,
    invoke: async (input) => {
      invocationInput = input;
      return {
        result: {
          status: "success",
          session: {
            mode: "persistent",
            storage: "s3",
            resumed: true,
            origin: "store",
            historyMessageCount: 2,
          },
          context: {
            usedTokens: 40_000,
            budgetTokens: 168_000,
            usedPercent: 24,
            verification: "passed",
          },
        },
      };
    },
  });

  assert.equal(invocationInput.operation, "compact");
  assert.equal(invocationInput.prompt, "");
  assert.equal(invocationInput.runtimeSessionId, existing.runtimeSessionId);
  assert.deepEqual(invocationInput.sessionHistory.map(({ id }) => id), ["u1", "a1"]);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ update }) => !("$push" in update)));
  assert.deepEqual(existing.messages.map(({ id }) => id), ["u1", "a1"]);
  assert.deepEqual(result.context, { usedPercent: 24 });
});

test("immediate compaction respects an active chat lease", async () => {
  let invoked = false;
  await assert.rejects(
    performChatContextCompaction(
      {
        _id: "chat-1",
        agentId: "agent-1",
        runtimeSessionId: "runtime-session-1",
        session: { status: "active" },
        messages: [],
      },
      { name: "Agent" },
      {
        chatModel: { findOneAndUpdate: async () => null },
        invoke: async () => {
          invoked = true;
        },
      },
    ),
    (error) => error.status === 409,
  );
  assert.equal(invoked, false);
});


test("failed immediate compaction releases the lease without creating an error message", async () => {
  const updates = [];
  const existing = {
    _id: { toString: () => "chat-1" },
    agentId: "agent-1",
    runtimeSessionId: "runtime-session-1",
    session: { status: "active", historyStartIndex: 0 },
    messages: [message("u1", "user", "Keep this")],
  };
  const chatModel = {
    async findOneAndUpdate(filter, update) {
      updates.push({ filter, update });
      return updates.length === 1
        ? { ...existing, session: { ...existing.session, status: "running" } }
        : existing;
    },
  };

  await assert.rejects(
    performChatContextCompaction(existing, { name: "Agent" }, {
      chatModel,
      resolveContextWindow: async () => 200_000,
      invoke: async () => {
        throw new Error("internal runtime detail");
      },
    }),
    /internal runtime detail/,
  );
  assert.equal(updates.length, 2);
  assert.ok(updates.every(({ update }) => !("$push" in update)));
  assert.equal(updates[1].update.$set["session.status"], "active");
  assert.equal(updates[1].update.$set["session.activeRequestId"], null);
  assert.deepEqual(existing.messages.map(({ id }) => id), ["u1"]);
});

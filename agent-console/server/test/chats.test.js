import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionHistory } from "../src/routes/chats.js";

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

import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayPrompt } from "../src/routes/chats.js";

test("leaves a first chat turn unchanged", () => {
  assert.equal(
    buildReplayPrompt([], "Inspect the repository."),
    "Inspect the repository.",
  );
  assert.equal(
    buildReplayPrompt(
      [{ role: "error", content: "A transient failure occurred." }],
      "Try again.",
    ),
    "Try again.",
  );
});

test("replays prior user and assistant turns in chronological order", () => {
  const prompt = buildReplayPrompt(
    [
      { role: "user", content: "Find the authentication code." },
      { role: "assistant", content: "It is in src/auth.js." },
    ],
    "Now add tests for it.",
  );

  assert.match(prompt, /^Continue the conversation below\./);
  const firstUser = prompt.indexOf("User:\nFind the authentication code.");
  const assistant = prompt.indexOf("Assistant:\nIt is in src/auth.js.");
  const finalUser = prompt.indexOf("User:\nNow add tests for it.");
  assert.ok(firstUser >= 0);
  assert.ok(firstUser < assistant);
  assert.ok(assistant < finalUser);
});

test("omits error messages from replay context", () => {
  const prompt = buildReplayPrompt(
    [
      { role: "user", content: "Inspect auth." },
      { role: "error", content: "SECRET FAILURE DETAIL" },
      { role: "assistant", content: "Auth uses middleware." },
    ],
    "Continue.",
  );

  assert.equal(prompt.includes("SECRET FAILURE DETAIL"), false);
  assert.equal(prompt.includes("Assistant:\nAuth uses middleware."), true);
});

test("bounds replay size and favors the most recent context", () => {
  const maximum = 180;
  const prompt = buildReplayPrompt(
    [
      { role: "user", content: "old context ".repeat(100) },
      { role: "assistant", content: "Recent answer." },
    ],
    "Recent question?",
    maximum,
  );

  assert.ok(prompt.length <= maximum);
  assert.equal(prompt.includes("Recent answer."), true);
  assert.equal(prompt.includes("old context"), false);
  assert.match(prompt, /User:\nRecent question\?$/);

  assert.equal(
    buildReplayPrompt(
      [{ role: "user", content: "prior" }],
      "x".repeat(100),
      50,
    ),
    "x".repeat(50),
  );

  // Header + final block can fit exactly while the separator required to join
  // them does not. With no prior turn selected, return only the latest message.
  const headerLength =
    "Continue the conversation below. Preserve its context and answer the final user message.\n\n".length;
  const latest = "boundary";
  const boundary = headerLength + "User:\n".length + latest.length + 1;
  assert.equal(
    buildReplayPrompt(
      [{ role: "assistant", content: "a prior answer that cannot fit" }],
      latest,
      boundary,
    ),
    latest,
  );
});

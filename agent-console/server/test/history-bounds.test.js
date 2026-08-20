/**
 * The replayed transcript has to stay out of the runtime's way.
 *
 * The console bounds what it sends; the runtime's context layer decides when a
 * conversation is too long and summarises the older half, reporting it as a
 * compaction. Whatever the console drops instead is gone with no summary and no
 * event, so the bound has to sit above the threshold the runtime will act on —
 * otherwise the console silently truncates first and compaction never happens,
 * which is what "it never auto-compacts" looks like from the outside.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionHistory,
  droppedHistoryCount,
  historyCharacterLimit,
} from "../src/routes/chats.js";

const at = "2026-08-10T00:00:00.000Z";
const message = (id, role, content) => ({ id, role, content, createdAt: at });

/** The same arithmetic the runtime uses to derive its input budget. */
const CHARACTERS_PER_TOKEN = 4;
const SAFETY_MARGIN_TOKENS = 2_000;

function compactionThresholdCharacters(
  contextWindow,
  maxOutputTokens,
  percent,
) {
  const budget = contextWindow - maxOutputTokens - SAFETY_MARGIN_TOKENS;
  return budget * (percent / 100) * CHARACTERS_PER_TOKEN;
}

test("the character bound stays above the threshold the runtime compacts at", () => {
  const windows = [
    { contextWindow: 32_000, maxOutputTokens: 4_096 },
    { contextWindow: 128_000, maxOutputTokens: 8_192 },
    { contextWindow: 200_000, maxOutputTokens: 8_192 },
    { contextWindow: 256_000, maxOutputTokens: 16_000 },
    { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  ];
  for (const { contextWindow, maxOutputTokens } of windows) {
    const limit = historyCharacterLimit(contextWindow);
    // 99 is the highest threshold an agent may configure, so it is the hardest
    // case for the bound to stay clear of.
    const threshold = compactionThresholdCharacters(
      contextWindow,
      maxOutputTokens,
      99,
    );
    assert.ok(
      limit > threshold,
      `a ${contextWindow}-token window bounds history at ${limit} characters, below the ${Math.round(threshold)} the runtime would compact at`,
    );
  }
});

test("the character bound scales with the model window", () => {
  assert.ok(
    historyCharacterLimit(1_000_000) > historyCharacterLimit(200_000),
    "a wider model must be allowed a longer replay",
  );
});

test("an unknown window falls back to the hard backstop rather than to nothing", () => {
  const backstop = historyCharacterLimit(undefined);
  assert.ok(backstop > 0);
  assert.equal(historyCharacterLimit(0), backstop);
  assert.equal(historyCharacterLimit(Number.NaN), backstop);
  assert.equal(historyCharacterLimit(-1), backstop);
});

test("a long chat is replayed whole rather than cut to a message count", () => {
  // 400 turns: comfortably past the 200-message cap that used to decide this, and
  // nowhere near enough text to trouble any model window.
  const messages = Array.from({ length: 400 }, (_, index) =>
    message(
      `m${index}`,
      index % 2 === 0 ? "user" : "assistant",
      `turn ${index} `.repeat(20),
    ),
  );

  const history = buildSessionHistory(
    messages,
    0,
    historyCharacterLimit(200_000),
  );

  assert.equal(history.length, 400);
  assert.equal(droppedHistoryCount(messages, 0, history.length), 0);
});

test("the backstop still bounds a pathological chat, and says what it dropped", () => {
  const messages = Array.from({ length: 5 }, (_, index) =>
    message(`m${index}`, index % 2 === 0 ? "user" : "assistant", "x".repeat(50)),
  );

  const history = buildSessionHistory(messages, 0, 120);

  assert.ok(history.length < messages.length);
  assert.equal(
    droppedHistoryCount(messages, 0, history.length),
    messages.length - history.length,
  );
  // The newest turns are the ones kept.
  assert.equal(history.at(-1).id, "m4");
});

test("the dropped count ignores turns that were never replayable", () => {
  const messages = [
    message("u1", "user", "a question"),
    message("e1", "error", "a transient failure"),
    message("empty", "assistant", ""),
    message("a1", "assistant", "an answer"),
  ];

  const history = buildSessionHistory(messages, 0);

  assert.deepEqual(
    history.map(({ id }) => id),
    ["u1", "a1"],
  );
  // The error and the empty turn were never candidates, so nothing was "dropped".
  assert.equal(droppedHistoryCount(messages, 0, history.length), 0);
});

test("the dropped count respects a context reset", () => {
  const messages = [
    message("u1", "user", "before the reset"),
    message("a1", "assistant", "also before"),
    message("u2", "user", "after the reset"),
  ];

  const history = buildSessionHistory(messages, 2);

  assert.deepEqual(
    history.map(({ id }) => id),
    ["u2"],
  );
  assert.equal(droppedHistoryCount(messages, 2, history.length), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ContextIndicator,
  contextPercent,
} from "../src/components/ContextIndicator.js";

const internalContext = {
  usedPercent: 42.2,
  usedTokens: 42_000,
  budgetTokens: 100_000,
  pressure: "aggressive",
  action: "tool-result-trimming",
  verification: "recovered",
  state: { constraints: 3 },
  timeline: [{ usedPercent: 80 }],
};

test("context indicator shows only the authoritative percentage and Compact", () => {
  const html = renderToStaticMarkup(
    ContextIndicator({ context: internalContext, onCompact() {} }),
  );
  assert.match(html, /Context/);
  assert.match(html, /42%/);
  assert.match(html, />Compact</);
  for (const hidden of [
    "42,000",
    "100,000",
    "aggressive",
    "tool-result",
    "recovered",
    "constraints",
    "timeline",
  ]) {
    assert.doesNotMatch(html, new RegExp(hidden, "i"));
  }
});

test("compacting state disables duplicate requests and changes the label", () => {
  const html = renderToStaticMarkup(
    ContextIndicator({
      context: internalContext,
      compacting: true,
      onCompact() {},
    }),
  );
  assert.match(html, /disabled/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Compacting…/);
});

test("percentage is read directly from runtime telemetry", () => {
  assert.equal(contextPercent({ usedPercent: 24.6 }), 25);
  assert.equal(contextPercent({ usedTokens: 5, budgetTokens: 10 }), null);
});

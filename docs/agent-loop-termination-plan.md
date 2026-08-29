# Agent Loop Termination — Build Plan

Status: draft, not started. Grew out of `feat-comp-use`'s `browser_use` testing —
two real runs (the cricket-score lookup, the first "1M context window" attempt)
hit `stopReason: max_turns` and ended mid-sentence, even though the second one had
already fetched the actual answer in its last tool result.

## 1. The bug, confirmed in code, not inferred

`agent-harness-clone/src/core/agent-session.ts`'s turn loop:

```ts
for (let turn = 1; turn <= this.limits.maxTurns; turn += 1) {   // line 309
  // ... model call, tool calls, results appended to history ...
  yield this.event({ type: 'turn.completed', turnId, turn, reason: 'tool_use' });  // line 657
}

yield this.event({ type: 'warning', code: 'MAX_TURNS_REACHED', ... });  // line 660
yield this.event({ type: 'session.completed', reason: 'max_turns', ... });  // line 665
```

Every turn that ends with the model requesting more tools loops back for another
turn. If the *last* turn (`turn === maxTurns`) also ends in `tool_use`, the loop
simply exits — there is no extra turn where the model is asked to stop calling
tools and answer with what it already has. The two failed runs are explained
completely by this: the model was mid-exploration exactly when the counter ran
out.

This is one instance of a more general point (confirmed against
`src/models/provider.ts`'s `StopReason` type, which already distinguishes
`'end_turn'` — the model decided it's done — from `'max_turns'` — a guardrail
fired): **whichever guardrail ends a run, the run should still end in a coherent
answer.** Today only one guardrail exists (`max_turns`), so that's where the fix
lands, but the fix should be framed generally enough that a future guardrail
(§4) can reuse it rather than needing its own copy of the same logic.

## 2. What already exists and doesn't need building

- The model-driven loop itself — termination is already "the model stops
  requesting tools," with `maxTurns` as a separate circuit breaker, not a rewrite
  of the loop into a dumb counter. Nothing wrong with the shape of this.
- Context compaction (`CompactingContextManager` / `DynamicCompactingContextManager`,
  `context.compaction.started`/`completed` events) — the `context_too_large`
  guardrail is already real.
- Per-turn correlation (`turnId`, `turn` index) already threads through every
  event, which both new pieces below can reuse.

## 3. Fix #1 — forced synthesis when a guardrail ends the run

**Behavior**: when the turn loop would otherwise exit via the `max_turns` path
(line 660 today), instead of immediately emitting the warning and finishing, make
**one further model call**:

- `tools: []` on that request (not the full `this.registry.descriptors()` every
  other turn gets) — mechanically prevents another tool call, the same "hard
  invariant over hope" reasoning as before: a soft instruction the model can
  ignore under momentum is not enough, this has already been watched failing.
- An appended instruction, distinct from the regular system prompt, e.g.:
  > You have used all available turns. Do not attempt to use any tool. Using
  > everything gathered so far in this conversation, give your best final answer
  > now. If it isn't enough to fully answer, say so honestly rather than
  > guessing — do not present an uncertain answer as certain.
  (The honesty clause matters: forcing a close-out must not become a euphemism
  for "generate a confident-sounding answer regardless of whether the data
  supports it.")
- The response's text becomes `assistant.text` as normal, appended to history,
  and the run finishes with `session.completed`. Keep `reason: 'max_turns'` on
  that event rather than inventing a new `StopReason` value — `StopReason` is a
  union type consumers pattern-match on (`agent-console`'s own run-folding code
  does this — see `RunTotals`/`run-totals.js`), and adding a member means an
  exhaustiveness update everywhere that matches on it for no real benefit; the
  event stream already lets a caller tell a synthesized close from a natural one
  if it cares, since the synthesis turn's request had no tools available.

**Where**: `agent-session.ts`, replacing the block at line ~660. The exact
factoring — a small helper that issues one model call with an overridden
`modelRequest` shape, versus inlining a trimmed copy of the per-turn call
logic — is an implementation decision to make while building it, not one worth
prescribing here.

## 4. Fix #2 — turn-budget awareness in the model's own context

**Behavior**: append a short budget line to the system prompt assembled each
turn (`agent-session.ts` line ~335-340, where `systemPrompt` is already joined
from `this.config.systemPrompt` + optional project context):

```
Turn 8 of 20 (12 remaining).
```

Cheap (a handful of tokens), and it's the difference between a model that's
blind to its own constraints and one that can pace itself — reserve broad
exploration for early turns, narrow down as the budget shrinks, on its own,
without needing Fix #1 to catch it every time.

**Decision to make before building**: this changes the system prompt — and
therefore token usage and possibly behavior — for every agent using this
harness, not just browser-heavy ones. Recommend adding it behind a
`AgentSessionConfig` option (e.g. `announceTurnBudget?: boolean`), default
**on** — the cost is negligible and the behavior change is strictly toward
"better paced," but making it an explicit, named option means it's a
deliberate, documented decision rather than a silent behavior change to every
existing agent.

## 5. Fix #3 — repeated-action detection (new, not in scope before this)

The one genuinely new idea from the research pass: nothing today stops the
model from retrying an action that already failed. Both real failures we
watched were exactly this — the same blocked click retried against ICC's
overlay (2 × 15s timeout, 30 wasted seconds and 2 wasted turns) and Google
search retried after the first CAPTCHA. The overlay-detection and
DuckDuckGo-redirect fixes already shipped are *specific* patches for those two
cases; this is the *general* guardrail that would have caught both without
either specific fix.

**Behavior**: track a short rolling history (last ~5) of `{toolName,
inputHash, isError}` per session, updated after each tool result. Before
executing a new tool call, compare it (name + a stable hash of the input)
against that history:

- **Exact repeat of a call that just failed** → don't execute it again at all.
  Return a synthetic tool result immediately: `"This exact call already failed
  moments ago with: <previous error>. Do not retry it unverified — try a
  different approach."` This is the valuable part: it saves the real wall-clock
  cost of the doomed retry (the 15s timeout), not just a turn.
- No match → execute normally, record the result into the rolling history.

**Where**: `agent-session.ts`, in the tool-execution section (line ~610-648,
where `toolCalls` are iterated and `results: ToolResultBlock[]` are collected)
— the natural point to check before calling `this.executeTool`/
`executeConcurrentToolBatch`, and to record into afterward.

**Decision to make before building**: apply universally (any tool, not just
`browser_use`) — a bash command retried identically after failing, or an MCP
tool call retried identically, are the same waste pattern. No reason to scope
this to browser tools specifically.

## 6. Testing

This touches shared core logic every agent on this harness goes through, not a
single tool — needs real coverage before it ships, using the same
`scripted-provider` fake-model pattern the existing test suite already uses
(`tests/core/`, presumably — confirm exact location when building):

- A scenario where the scripted model always requests a tool call, never stops
  on its own, with a small `maxTurns` — assert the run now makes one additional
  no-tools call and ends with real text in `assistant.text`, not silence or a
  truncated stream.
- A scenario where the model requests the identical tool call twice in a row
  with the first failing — assert the second is short-circuited (the tool's own
  `execute` is never actually called a second time) and the model receives the
  synthetic "already tried, don't retry" result.
- A regression check that a run which finishes normally (`end_turn` before
  `maxTurns`) is completely unaffected by either change.

## 7. Sequencing

Build in this order: **Fix #1 first** — it's the one that directly resolves the
two real failures observed, and it's self-contained (one new call, no new
per-session state). **Fix #3 next** — genuinely new value, moderate scope
(rolling history + a comparison), independent of #1. **Fix #2 last** — cheapest
to build, but lowest leverage on the actual bug; nice-to-have pacing
improvement once the guardrails around it are solid.

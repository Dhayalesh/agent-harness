# GenAI / Agent Observability — Build Plan

Status: draft, not started. Written from the architecture brief pasted 2026-08-08,
re-scoped into phases against what actually exists in this repo today
(`agent-harness-clone`'s `AgentEvent`/`EventSink` pipeline and `agent-console`'s
Express + MongoDB control plane). Updated 2026-08-08 after checking the exact event
shapes in `agent-harness-clone/src/core/events.ts` and reconciling with AWS's own
Session/Trace/Span model.

## 1. Goal

Give every agent invocation a Langfuse-style trace: a tree of spans (turns, model
calls, tool calls) with timing, token usage, and cost, queryable and viewable per
session — without depending on AWS CloudWatch GenAI Observability or a hosted
third-party product.

This is a **first-class feature of `agent-console`**, not a debugging side-channel —
a permanent nav item ("Observability" / "Traces") next to Agents, Chats, and Runs,
maintained the same way those are. It is deliberately host-agnostic: `agent-harness`
already runs both inside AgentCore and locally (`npm start`), and building this on
top of the harness's own `AgentEvent` stream — rather than on AWS's CloudWatch
Transaction Search / ADOT pipeline — means it works identically regardless of where
a given deployment's runtime actually lives. See §8 for exactly why the AWS path
isn't a shortcut here: it requires its own SDK dependency, its own account-level
setup, and only outputs to AWS's fixed dashboard, none of which serves an in-app
feature.

## 2. Terminology: session, trace, turn, span

Four levels, and it matters to keep them straight because "prompt" is genuinely
ambiguous — it means two different things depending which level you're looking at.

| Level | What it is | Identified by | Real thing in this repo |
| --- | --- | --- | --- |
| **Session** | The whole conversation, across any number of user messages | `sessionId` / `runtimeSessionId` | a `Chat` document in `agent-console` |
| **Trace** | The complete response to *one* user message | `traceId` (= the `runId`) | a `Run` document — one `POST /invocations` call |
| **Turn** | One iteration of the model's internal loop inside a trace: one model call, then optionally a tool call and another turn | `turnId` | one `turn.started`/`turn.completed` pair |
| **Span** | The leaf unit doing real work: a **Generation** (one LLM call) or a **Tool call** (one function execution) | `spanId` + `parentSpanId` | an `assistant.*` block, or a `tool.requested`→`tool.completed` pair |

A session holds many traces. A trace holds one-or-more turns (usually one, more if
the agent loops). A turn is exactly one generation plus zero-or-more tool calls.

**Resolving "prompt":** the user's prompt (what someone typed) is the input to one
**trace** — there's exactly one per trace. The model's prompt (the literal input sent
to the LLM for one completion) belongs to one **generation span** — a single trace
can contain several of these if the agent loops. "A group of prompts" = a trace.
"Each session" = every trace in one conversation.

Worked example, the `sql-analyst` case from the design mockup: one user message
("walk through last week's funnel, table by table") is one trace; the agent takes
seven turns to answer it (one query per funnel stage, plus a final synthesis turn
with no tool call) — 7 generation spans + 6 tool-call spans = 13 spans, all under
that one trace, all under one session.

**Turn is not a stored entity.** It's fully derivable: a turn is a generation span
plus whatever tool-call spans share it as `parentSpanId` — exactly the
`parent_span_id` field already in the §5 data model. No third "turns" collection is
needed; "turn" is a rendering grouping, which is also how AWS's own model works —
their Session→Trace→Span is the same three *stored* tiers, no separate turn concept
either.

## 3. What already exists and should be reused, not rebuilt

Verified directly against `agent-harness-clone/src/core/events.ts`, not assumed —
most of what a trace tree needs is already emitted:

| Need | Already emitted as | Notes |
| --- | --- | --- |
| Session id | `sessionId` on every event (`EventBase`) | shared across a whole chat |
| Turn boundaries | `turn.started` / `turn.completed` | carries `turnId`, `turn` index, `reason` |
| Generation output | `assistant.text.delta`, `assistant.reasoning.delta`, `assistant.message.completed` | streamed and whole-message forms |
| Generation usage/cost | `usage.updated` | **already carries `turnId`** — per-turn cost attribution needs no harness change |
| Tool call span | `tool.requested` → `tool.started` → (`tool.progress`)\* → `tool.completed` | `call.id`, `call.name`, `call.input`, `result.content`, `result.isError` all present |
| Failure | `error`, `warning` | `code`, `message`, `recoverable` |

Supporting infrastructure already in place:

- `agent-harness-clone/src/services/observability.ts` — `EventSink`,
  `CompositeEventSink`, `StructuredLogSink`, `MetricsSink`: the "Telemetry Ingestion +
  Normalization" layer the original brief asked for, already running in-process.
- `agent-harness-clone/src/services/observability.ts:agentEventCorrelation()` —
  already derives `turnId`/`toolCallId` per event.
- `agent-console`'s `runs` collection already stores the full `events[]` array per
  invocation when `includeEvents: true` (see `runtimeResultSchema`, `RunTotals`). A
  trace tree can be *derived* from data that's already persisted.
- `agent-console/client/src/pages/RunDetailPage.jsx` is the existing slot for a trace
  waterfall view — no new frontend app needed.

### Two real gaps, and the decision each one needs

**1. No per-invocation trace id on the events themselves.** `EventBase` only carries
`sessionId` (the whole-chat id) — nothing marks "this batch of events is trace X."
This does **not** need a harness change: `agent-console` already knows both ids at
the moment it calls the runtime — it creates the `Run` (= trace) row *before*
invoking, and it already owns the event stream via `streamStoredAgent` /
`openAgentRuntimeStream`. So trace-tree construction belongs in `agent-console`,
where `run._id` is already in scope, not in a new harness-side sink. This changes
Phase 1 below from what was originally planned.

**2. The model's actual input is never emitted, only its output.** Every generation
event describes what the model *said*, never what it *saw*. Two ways to close this:
   - **(a) Harness change** — emit a new event (e.g. `generation.requested`) carrying
     the actual request messages before calling the provider. Accurate, but touches
     the turn loop.
   - **(b) Reconstruct it, no harness change** — rebuild "what the model saw for turn
     N" from data already available: the agent's `systemPrompt`, the original user
     prompt, and every prior turn's output + tool result as they arrive. Free, but
     it's inference — if the harness ever does something non-obvious to the prompt
     (compaction, injected context), the reconstruction silently drifts from what was
     actually sent.

Recommendation: start with (b). It costs nothing and matches "no new infrastructure"
for Phase 0/1; revisit (a) only if the reconstructed input visibly disagrees with
reality once real traces are in front of you.

## 4. Phased plan

### Phase 0 — Derived trace viewer, no new infrastructure (MVP)
Goal: prove the data model and UI are right before building any ingestion pipeline.

- Write a pure function `buildTraceTree(events: AgentEvent[]): Trace` in
  `agent-harness-clone` (or a shared package) that replays a stored `events[]` array
  into: one `Trace`, `Span` observations per turn, `Generation` observations per
  model call (buffered from `assistant.text.delta` / `assistant.reasoning.delta` +
  the matching `usage.updated`, input reconstructed per §3's option (b)), and `Span`
  observations per tool call (`tool.requested` → `tool.completed`).
- Add a read-only endpoint in `agent-console`, e.g. `GET /api/runs/:id/trace`, that
  runs this function over the run's stored `events`.
- Add a trace waterfall panel to `RunDetailPage.jsx` — nested bars positioned by
  `(startedAt, endedAt)` relative to trace duration. This is the whole visual
  vocabulary a v1 needs; no charting library required.
- Storage: none new. Reuses the existing `runs` collection.

**Exit criteria:** you can open any run that was invoked with `includeEvents: true`
and see its trace tree with timings, token usage, and tool I/O.

### Phase 1 — Live ingestion, still on MongoDB
Only once Phase 0's shape is validated as useful.

- **No new harness-side sink.** Per §3's first gap, `agent-console` already receives
  the live event stream (`streamStoredAgent` in `server/src/services/invocation.js`)
  with the trace id (`run._id`) already in scope. Reuse the *same*
  `buildTraceTree`-shaped logic from Phase 0 as an `onEvent` hook there, alongside
  the existing `RunTotals.observe(event)` call, closing and persisting each
  observation as its bounding event arrives instead of replaying a stored array
  after the fact. The buffered path (`invokeStoredAgent`) keeps using Phase 0's
  after-the-fact replay, since a buffered call never exposes a live event stream.
- Add `traces` and `observations` collections to `agent-console` (schema per §6
  below).
- Add basic rollups: cost/latency/error-rate by agent, by model, by day. Plain
  Mongo aggregation pipelines — no metrics store yet.
- Static, versioned pricing: a JSON map (`provider/model → {input, output}` per
  1K tokens) checked into git, with a `pricingVersion` stamped on every generation
  observation at write time so historical spend never silently changes when prices
  are updated later — needed because `ModelUsage.estimatedCostUsd` is optional and
  not every provider reports it.

**Exit criteria:** a trace is visible while (or immediately after) a run is still
in flight, and a cost dashboard exists across the last N days.

### Phase 2 — Scale-driven infrastructure (only if actually needed)
Do not start this until Phase 1's Mongo aggregations are measurably too slow, or
until invocation volume is high enough that batch inserts contend with the
application's own writes. Concretely:

- ClickHouse (or similar columnar store) for the `observations` table once its row
  count or query latency actually justifies leaving Mongo.
- A queue (Kafka/Redpanda/SQS) between ingestion and storage, if and when a single
  process writing observations becomes a throughput bottleneck.
- Redis, if and when dashboard queries are measurably slow without a cache.

### Phase 3 — Multi-tenant, RBAC, alerting
Only relevant if this becomes something other people/teams use, not just internal
debugging for this repo's own agents. Requires `agent-console` to have real
authentication first — see §7, downside 4.

## 5. Data model (kept from the original brief — this part is genuinely right)

```json
{
  "trace_id": "runId",
  "session_id": "sessionId",
  "span_id": "uuid",
  "parent_span_id": "uuid | null",
  "operation_type": "AGENT | LLM | TOOL",
  "name": "string",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601",
  "status": "success | error",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "cost": { "amount": 0, "currency": "USD", "pricingVersion": "2026-08" },
  "input": "redacted per privacy policy",
  "output": "redacted per privacy policy",
  "metadata": {}
}
```

`trace_id` and `session_id` are deliberately separate fields (see §2) — a trace is
one user message, a session is every trace in one chat. `agent_id`, `agent_version`,
`environment`, `provider`, `model` attach at the trace level (from the payload's
`agent`/`modelProvider` blocks) rather than being repeated on every observation.

## 6. Storage schema (Phase 1)

- `traces`: `{ id, sessionId, agentId, agentName, model, provider, startedAt,
  endedAt, status, totalUsage, totalCost, runId }` — **one per trace** (one per
  `Run`/invocation, i.e. one per user message), grouped under `sessionId` for the
  chat-level view. Mirrors `runs` but keeps observability concerns separate from
  invocation bookkeeping.
- `observations`: `{ id, traceId, parentId, type, name, startedAt, endedAt, status,
  input, output, usage, cost, metadata }` — one per span (generation or tool call).
  `parentId` pointing at a generation's own id is what makes "turn" a derivable
  grouping rather than a stored one (§2).

Both collections live in the same MongoDB database `agent-console` already uses;
no new datastore in Phase 0 or Phase 1.

## 7. Downsides and risks of the original (unphased) brief

The brief as pasted describes the eventual, at-scale, multi-tenant version of a
product like Langfuse or Datadog LLM Observability, designed as if starting from
zero. Building it in that form now, rather than the phased version above, has real
costs:

1. **Operational burden mismatch.** The full architecture adds seven new pieces of
   infrastructure to operate, monitor, back up, and secure — Kafka/Redpanda,
   ClickHouse, a Prometheus-compatible TSDB, Redis, S3, Postgres, and an OIDC
   provider — on top of the one MongoDB Atlas cluster this project currently runs.
   Every one of those is itself a production system with its own failure modes.
2. **A working version of most of this already exists as open source.** Self-hosted
   Langfuse implements sections 6–16 of the brief (canonical event model, trace
   tree, cost analytics, dashboards, evaluations) today. Building a bespoke
   equivalent at this fidelity is re-implementing a mature product, not a
   weekend project — worth being honest that "build it myself" at this scope is
   months of work, not days.
3. **Scale infrastructure chosen before there's a scale problem.** Kafka, ClickHouse,
   and Prometheus solve throughput and query-latency problems this repo has no
   evidence of yet (one AgentCore runtime, no measured QPS). Standing them up now
   means paying their complexity tax before there's a load problem to justify it,
   and getting the trace schema and dashboards right the first time is *harder*
   with infrastructure in the loop, not easier.
4. **Security scope is inverted.** The brief designs multi-tenant RBAC, OIDC/SSO,
   and audit logging for the observability platform while `agent-console` — the
   application this would observe — currently has **no authentication at all**
   (documented in this repo's own README security section, and already flagged
   earlier this session). Securing the observability layer before the thing it's
   observing has any access control is solving the wrong layer first.
5. **Pricing-versioning as designed is heavier than the guarantee requires.** The
   underlying instinct — never let a price update silently reprice historical spend
   — is correct and worth keeping. A full versioned Postgres pricing schema is more
   machinery than two providers (`openrouter`, `openai-compatible`) need; a
   git-committed JSON price map with a `pricingVersion` string stamped per
   observation gets the same guarantee for near-zero operational cost.
6. **"Ingestion API" as a fourth standalone service.** The brief frames telemetry
   ingestion as its own deployable with its own auth and rate limiting.
   `agent-console` already is the right shape for this (Express + Mongo,
   already the control plane for everything this would trace) — new routes on it
   are far cheaper to build, deploy, and reason about than a new service.
7. **No acknowledgment of what already exists in this codebase.** The brief is
   written as a greenfield design. In practice, the "Telemetry Ingestion +
   Normalization" layer it specifies already exists as `AgentEvent` +
   `EventSink`/`CompositeEventSink` in `agent-harness-clone` — large parts of
   sections 4 and 6 are already done and just need a consumer, not a new pipeline.
8. **Redis and object storage are speculative.** Caching and archival both solve
   problems (slow dashboards, long-term retention) that don't exist yet at Phase
   0/1 scale; adding them now is optimizing before there's a measurement showing
   they're needed.

## 8. Why the AWS path isn't a shortcut here

Checked against the current AWS docs (2026-08), not memory. AgentCore's real
"GenAI Observability" dashboard runs on a structurally different pipe than logging:

- **Two separate layers.** AgentCore emits session-level metrics (count, latency,
  duration, tokens, error rate) automatically, with zero app code. Actual
  traces/spans do not: they require adding the ADOT SDK (`aws-opentelemetry-distro`)
  to the agent process, run via `opentelemetry-instrument`, emitting real OpenTelemetry
  spans under the GenAI semantic conventions — an app-level dependency and code change,
  not a flag.
- **Spans travel as X-Ray trace segments, not log lines.** They're delivered over
  OTLP, land as X-Ray segments, and only appear in the CloudWatch GenAI Observability
  page once **CloudWatch Transaction Search** is explicitly enabled once per AWS
  account (console toggle, or `PutResourcePolicy` + `UpdateTraceSegmentDestination`).
  Without that one-time setup, no span data reaches the dashboard no matter what the
  app does.
- **What this repo's `CloudWatchLogWriter` currently does is neither of these.** It
  calls `PutLogEvents` against a log group it owns — that's plain CloudWatch Logs.
  It will never populate the GenAI Observability Traces/Sessions view, because that
  view is fed exclusively by X-Ray segments through Transaction Search, not by
  arbitrary `PutLogEvents` JSON lines. So the custom writer buys searchable logs in
  Logs Insights, not what "GenAI Observability" actually means at AWS.
- **The correlation IDs are already right, though.** AWS's own mechanism keys
  spans/traces off `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` and `X-Amzn-Trace-Id`
  — and `agent-harness-clone/src/headless/server.ts` already reads exactly these two
  headers (`AGENTCORE_RUNTIME_SESSION_HEADER`, `AWS_TRACE_HEADER`) to tag every log
  line. The IDs threaded through this repo today are the same ones a real OTEL
  integration would use — only the payload they're attached to (a log line vs. a
  span) differs.

Net: getting real traces onto AWS's own dashboard means an OTEL SDK dependency plus
one-time account setup, in exchange for AWS's fixed UI. Building the trace tree from
`AgentEvent`s this repo already produces avoids that dependency entirely and gives
you a UI that's actually part of the product — which is the goal stated in §1.

## 9. Proof of concept — fake data, no backend dependency

Before wiring any real ingestion (Phase 1) or even the derived-from-stored-events
read path (Phase 0's endpoint), validate the UI and data model in isolation. This is
the fastest way to get something clickable in front of a person and agree the design
is right before writing any harness or Mongo code.

- **Fixture, not a live endpoint.** Write 3 static JSON files matching the §5 trace
  schema by hand, covering the shapes the real thing must render correctly:
  1. a clean run — one generation, two sequential tool calls, all success;
  2. a run with a failing tool call and a retry — exercises error styling and
     same-parent sibling spans;
  3. a longer multi-turn conversation — exercises vertical scrolling and a trace
     with several turns, each with its own generation + tool spans.
- **Wire it through the real shape, not a shortcut.** Even for the POC, serve the
  fixtures from an actual `agent-console` route, e.g. `GET /api/observability/mock-traces`
  and `GET /api/observability/mock-traces/:id`, returning the same JSON shape the
  real `GET /api/runs/:id/trace` (Phase 0) will return later. This means zero of the
  frontend work gets thrown away once real data is wired in — only the route handler
  body changes, from "read a fixture file" to "run `buildTraceTree` over stored
  events."
- **Frontend, in `agent-console/client`:**
  - A new nav entry in `AppShell.jsx`: "Observability."
  - `ObservabilityPage.jsx` — a list view (reuse `PageHeader`, `SectionCard`, the
    `ResourceRow` pattern) showing the 3 fixture traces: agent name, status,
    duration, total cost, timestamp.
  - `TraceDetailPage.jsx` — the actual deliverable: a recursive `SpanRow` component
    rendering each observation as a horizontal bar positioned and sized by
    `(startedAt, endedAt)` relative to the trace's total duration, indented by
    nesting depth, color-coded by `operation_type` (LLM / TOOL / AGENT), red for
    `status: "error"`. Click a span to expand its input/output/usage in a side or
    inline panel. A second "Flow" view — a node graph (start → per-turn model-call
    and tool-call nodes, grouped in a dashed box per turn → end) — gives the same
    data a structure/dependency reading instead of a timing reading; see the
    published mockup for the concrete layout (elbow connectors, edge labels for
    `calls`/`retry`/`result`, a one-line caption stating what each trace's flow
    shows).
  - Both pages must work in light and dark theme (the app's existing
    `theme.jsx` mechanism) — this is a real screen, not a throwaway.
- **Explicitly not in the POC:** no live ingestion, no new Mongo collections, no
  cost roll-ups, no filtering/search. Just: can you look at a trace and understand
  what the agent did, in what order, and what it cost.

**Exit criteria:** someone who has never seen the raw `AgentEvent` stream can look at
the `TraceDetailPage` for fixture #2 (the failing-tool-call one) and correctly
explain what failed and what happened next, without being told.

## 10. Recommendation

Build the §9 POC first, then Phase 0, then Phase 1. Each step requires no new
infrastructure, uses data that either already exists or is trivially faked, and
answers a real question — is the trace tree the right shape, is it useful for
debugging, is live ingestion worth the plumbing — before the next step's investment
is justified. Revisit Phase 2's infrastructure only against a measured bottleneck,
not in anticipation of one.

## 11. Design brief — prompt for a design-focused conversation

Use this as the opening prompt in a conversation whose job is producing visual
design/mockups for this feature (not implementation code). It's self-contained on
purpose, since a design tool won't have this conversation's context.

```
I'm designing a new feature called "Observability" (or "Traces") for an existing
internal web app called agent-console. It's a control plane for AI agents: React 18
+ HeroUI + Tailwind CSS on the frontend, Express + MongoDB on the backend. Existing
screens: Agents, Model Providers, MCP Servers, Skills, Chats, Runs, Dashboard — each
follows a shared pattern (PageHeader, SectionCard, a list/table page plus a detail
page, light/dark theme support driven by a class on <html>).

Design two new screens that fit this existing product, not a generic dashboard:

1. TRACES LIST — a table/list of past agent invocations ("traces"). Each row shows:
   agent name, status (success/error), start time, duration, total tokens, total
   cost, and a short preview of the first user message. Supports filtering by agent
   and status, and a time range. Clicking a row opens the trace detail.

2. TRACE DETAIL — the core screen. A trace is a tree: one root (the session), containing
   one or more turns, each turn containing one "generation" (a model call: input
   messages, output text, token usage, latency) and zero or more "tool calls" (name,
   arguments, result, duration, success/error). Design this as a waterfall/Gantt view:
   each node is a horizontal bar positioned and sized by its start time and duration
   relative to the whole trace, indented by nesting depth, color-coded by type
   (model call vs. tool call vs. error). Clicking a bar expands a detail panel showing
   that node's full input, output, token usage, and timing. The screen needs to make
   two things immediately legible at a glance: (a) what happened, in what order, and
   (b) where the time and money went — a slow tool call or an expensive model call
   should visually stand out without reading numbers.

Constraints:
- Must work in both light and dark theme, using a single brand color ramp (not
  scattered hex values).
- Reuse the visual language of a settings/admin dashboard, not a marketing page —
  dense, functional, data-first, similar in spirit to Vercel's dashboard, Linear's
  issue view, or Langfuse/Datadog's trace viewer.
- Design for three concrete states in the detail view: a clean successful trace, a
  trace with one failed tool call, and a long trace with many turns needing vertical
  scroll — show how each looks.
- Out of scope: no alerting, no multi-user/tenant UI, no live-updating/streaming
  view — traces are viewed after the fact, not in real time.

Deliverable: high-fidelity mockups of both screens, in both themes, covering the
three states above for the trace detail screen.
```

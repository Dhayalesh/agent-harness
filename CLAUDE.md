# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

This is not a single project or a workspace/monorepo — there is no root `package.json`.
It is three independent Node.js projects sitting side by side, each with its own
install/build/test cycle. `cd` into the relevant one before running any command.

| Directory | What it is |
| --- | --- |
| `agent-harness-clone/` | The product: a headless TypeScript agent runtime (`@trueai/agent-harness`). One HTTP contract (`POST /invocations`), no stored config, deployed as an AWS Bedrock AgentCore Runtime image. |
| `agent-console/` | A React + Express control plane that manages agent/model-provider/MCP/skill records in MongoDB and invokes the deployed harness via `InvokeAgentRuntime`. |
| `claude-code/` | **Reference-only**, not part of the product. See below — do not build, run, or import from it as part of feature work. |

### `claude-code/` is a clean-room reference, not a dependency

`claude-code/` is a third-party tree (its own README describes it as leaked Anthropic
CLI source) kept solely so `agent-harness-clone` can be developed as a **clean-room
reimplementation** of the same externally observable behavior. The rules are in
`agent-harness-clone/CLEAN_ROOM.md`:

- Never copy source files or verbatim code fragments from `claude-code/` into
  `agent-harness-clone/` or `agent-console/`.
- Treat it as a behavioral spec: use it to understand *what* a feature should do,
  then design independent module boundaries, names, types, and implementation.
- Record desired behavior as a contract/test before implementing it.
- `claude-code/src/` is explicitly marked "should not be modified" by its own docs.

If a task asks you to port or match something from `claude-code/`, implement it
clean-room in `agent-harness-clone` rather than copying — and prefer public
protocol/API docs (e.g. MCP spec) over the reference source for provider/MCP details.

---

## `agent-harness-clone/`

Headless agent runtime. Everything a run needs (system prompt, model + credential,
tools, MCP servers, skills) travels on the request payload; the process holds no
stored configuration. Full detail is in `agent-harness-clone/README.md` — read it
before making non-trivial changes, especially the payload contract, streaming event
protocol, and the AgentCore deployment limits.

### Commands

Run from `agent-harness-clone/`:

```bash
npm install
npm run check          # format:check + typecheck + test — run before considering work done
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm run format         # prettier --write .
npm run format:check
npm test               # tsx --test tests/**/*.test.ts
npm run build          # clean + tsc -p tsconfig.build.json -> dist/
npm start              # runs the HTTP server (src/headless/main.ts)
npm run payload -- payload.json [--stream]   # run one payload from a file
npm run export-payload -- --agent <name> --out payload.json   # migrate a MongoDB-stored agent to a payload
```

Single test file:

```bash
tsx --test tests/headless/headless.test.ts
```

Tests need no external credentials — a local HTTP server plays the model, so a full
turn (including tool execution and file writes) runs for real with nothing external.

### Architecture

The invocation path is five files under `src/headless/`:

- `payload.ts` — the request contract, as zod schemas (the source of truth for what a
  caller may send)
- `inline-agent.ts` — turns a payload into an assembled agent. It does this by
  completing the payload's blocks into the same record shapes `PlatformAgentRegistry`
  validates (`src/platform/*-registry.ts`) and synthesizing the cross-references
  between them, so a payload-defined agent is assembled through the exact same code
  path a MongoDB-stored agent went through. There is deliberately one assembly path,
  not two that could drift.
- `invoke.ts` — runs a prepared agent, buffered or streamed
- `server.ts` — the HTTP surface (`/invocations`, `/invocations/permissions`, `/ping`)
- `run-registry.ts` — optional state backing resumable runs and `permissionFallback:
  'ask'`; only relevant when `resumableRuns: true`

Supporting layers, each independent and worth knowing where to look:

- `src/platform/` — registries and definitions for agents, model providers, MCP
  servers, and skills (the shapes `inline-agent.ts` targets)
- `src/models/` — provider adapters (`openrouter-provider.ts`,
  `openai-compatible-provider.ts`), plus `retry-provider.ts` (wraps any provider with
  retry) and `scripted-provider.ts` (the fake model used in tests)
- `src/core/` — `agent-session.ts`, `events.ts`, `messages.ts`: the session/event model
  that both the buffered and streaming paths produce
- `src/mcp/client.ts` — MCP server connection and request/response handling
- `src/permissions/` — permission-mode and rule-based decision logic
- `src/runtime/` — `runtime-host.ts` / `local-runtime-host.ts`: workspace and process
  execution host for tools
- `src/tools/` — built-in tools (`builtin/`, `shell/`, `web/`); a payload names the
  subset it wants via `agent.tools`
- `src/content/`, `src/context/`, `src/sessions/`, `src/skills/`, `src/services/`,
  `src/artifacts/`, `src/hooks/` — supporting concerns for content limits, skill
  front-matter parsing, and session/service plumbing

Key behavioral points to keep in mind when touching this code (see README for full
detail on each):

- Every payload object is strict — an unrecognized key is a rejected payload, not a
  silently ignored one.
- `AGENT_PERMISSION_CEILING` lets a deployment cap what any payload may request
  regardless of the payload's own `permissionMode`.
- Structured JSON logging to stdout is on by default and redacts credential-shaped
  keys/token patterns before a record is written; large records are chunked
  (`log.chunk`) rather than dropped.
- `plan` mode and `ask_user_question` are intentionally not offered as tools — nothing
  is watching a payload-driven run to answer them, and `permissionFallback: 'ask'` is
  refused outright unless both streaming and `resumableRuns` are in play.
- `scripts/headless/exportPayload.ts` is the only code path that still opens MongoDB
  (to migrate a legacy stored agent to a self-contained payload file); it is
  deliberately standalone.

---

## `agent-console/`

MongoDB-backed control plane for the historical `trueai_agent_platform` collections
(`agents`, `model_providers`, `mcp_servers`, `skills`), plus console-owned `chats` and
`runs` collections. It resolves an agent's referenced model provider/MCP
servers/skills, inlines them into a harness payload, and invokes the deployed
AgentCore runtime — it does not run the harness locally. Full API surface, streaming
semantics, and troubleshooting notes are in `agent-console/README.md`.

### Commands

Run from `agent-console/`:

```bash
npm run install:all    # installs root, server, and client
npm run dev            # concurrently runs server (127.0.0.1:4000) and Vite client (localhost:5173)
npm run build           # client production build (npm --prefix client run build)
npm start               # single-process production: Express serves client/dist + /api
npm test                # server test suite (npm --prefix server test)
npm run seed             # optional: writes example records into the configured DB — check the resolved DB first
```

Server-only test run (from `agent-console/server/`):

```bash
node --test                                 # full suite
node --test test/chats.test.js              # single file
```

Client dev server only: `npm --prefix client run dev`.

Configuration is `server/.env` (copy from `server/.env.example`). Startup prints the
resolved, redacted MongoDB target and database — check it before any write, since an
ambient `MONGODB_URI`/`MONGODB_DB_NAME` overrides the `.env` file.

### Architecture

- `server/src/routes/` — Express route handlers (agents, model-providers, mcp-servers,
  skills, chats, runs, catalogue/dashboard/health)
- `server/src/models/` — Mongoose schemas for the platform + console collections
- `server/src/services/` — invocation resolution (dereferencing an agent's model
  provider/MCP/skills, downloading skill documents from S3, building the harness
  payload, calling AgentCore, translating/persisting the result)
- `server/src/lib/` — shared helpers (config, redaction, validation)
- `client/src/pages/` — one route per screen
- `client/src/components/Bits.jsx` — shared primitives every page composes
  (`PageHeader`, `SectionCard`, `StatTile`, `MetaGrid`, `EmptyState`, `ToggleCard`,
  `FormActions`, date/token formatters)
- `client/src/components/ResourceRow.jsx` — the one row shape the model/MCP/skill list
  pages share
- `client/src/components/MapEditor.jsx` — the header/environment/argument map editor
  shared by the two credentialed forms (model providers, MCP servers)
- `client/src/theme.jsx` — owns the dark/light class on `<html>`; `index.html` has a
  small inline script that applies it before React mounts to avoid a flash
- `client/tailwind.config.js` — single brand color ramp feeding the `heroui()` plugin;
  its `content` globs must include both the hoisted and nested `@heroui/theme`
  locations or HeroUI components render unstyled

Points worth remembering when changing this code:

- Secrets (`apiKey`, header/env values) are never returned by the list/detail/catalogue
  APIs — only `hasApiKey`/`hasHeaders`/`headerNames`-style booleans and key lists.
  Preserve this redaction pattern when adding fields.
- PATCH semantics distinguish "omit = unchanged" from explicit clear values (`""` vs
  `null` behave differently per field — see the README's PATCH section before changing
  update handlers).
- One global `AGENTCORE_RUNTIME_ARN` serves every agent; there is no per-agent runtime.
  Each invocation is a single AWS SDK call with `maxAttempts: 1` — no automatic retry,
  since retrying an agent turn can duplicate side effects.
- Streaming vs buffered is decided independently at each hop by what the caller
  actually asked for (`Accept` header / `?stream=`), falling back to the agent's stored
  `stream` preference only when the caller stated nothing. Don't conflate "the console
  asked AgentCore to stream" with "the browser gets SSE" — they're separate decisions.
- The API has no authentication or multi-tenancy and binds to loopback by default;
  don't add features that assume an authenticated caller without also adding the auth.

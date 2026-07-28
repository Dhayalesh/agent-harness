# Agent Harness Clone

A UI-independent TypeScript agent runtime for Node.js. Terminal, HTTP/SSE,
JSONL, desktop, IDE, remote-runtime, and embedded SDK consumers all use the
same `AgentSession` API and versioned, serializable event protocol.

This repository contains the harness layer only. Rendering, terminal UI,
browser UI, Electron windows, and editor-specific UI remain consumer-owned.

## Requirements

- Node.js 22 or newer
- npm
- MongoDB, plus one `model_providers` record: the CLI and the service read their
  model and credential from that record only

Every live model is routed through [OpenRouter](https://openrouter.ai/models),
so model ids are OpenRouter slugs in `vendor/model` form (for example
`anthropic/claude-sonnet-4.6`, `openai/gpt-4.1-mini`, `google/gemini-2.5-pro`).
`listOpenRouterModels()` resolves the live catalog from the gateway, and
`OpenRouterModelProvider#assertModelAvailable()` fails fast on an unroutable
slug.

## Install and verify

```bash
npm install
npm run check
npm run build
```

## Configuration

Copy the annotated template and fill in what you need:

```bash
cp .env.example .env
```

`.env` is gitignored and loaded automatically by the `agent`, `service`,
`demo:client`, and `test` scripts through Node's `--env-file-if-exists`. Real
process environment variables always win over `.env` values.

`PLATFORM_MONGODB_URI` is the single connection string, and its path segment is
the database name (`mongodb://127.0.0.1:27017/trueai_agent_platform`).
`PLATFORM_MODEL_PROVIDER` optionally names which record to use, and an empty
value selects the enabled default record. Those two variables are the whole
surface: the model, the endpoint, and the credential all come from one
`model_providers` record. Nothing in the environment can supply or substitute
any of them, and there is no fallback when the record is missing a field.

Three scripts in `model_scripts/` write those records. Each talks to MongoDB
directly, matches records by `name`, and takes its input from variables at the top
of the file:

```bash
node model_scripts/seedModel.js     # add new records
node model_scripts/editModel.js     # change one existing record
node model_scripts/deleteModel.js   # remove one record
```

Each script does one thing and refuses the others' work: adding a name that
exists, or editing or deleting one that does not, is an error rather than a silent
insert or no-op. `deleteModel.js` additionally requires `CONFIRM = true`, since it
destroys a stored credential. `contextWindow` and `maxOutputTokens` are required
when adding, because the CLI spends them as the session's input budget and output
ceiling.

Because the credential sits on the record next to the `baseURL` it is sent to,
write access to `model_providers` is equivalent to holding the key. Run MongoDB
with authentication, give the runtime a least-privilege read-only user, restrict
writes to operators, and enable encryption at rest.

`npm run check` verifies formatting, TypeScript, deterministic integration
tests, security boundaries, transport contracts, and cross-surface acceptance.

## Terminal

Configure the LLM once, in `model_scripts/seedModel.js`. An `openai-compatible`
entry needs its endpoint in `baseURL`, which the canonical OpenRouter gateway does
not:

```js
const MODELS = [
  {
    name: 'openrouter-default',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6',
    apiKey: '<credential>',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    isDefault: true,
  },
];
```

```bash
node model_scripts/seedModel.js
```

Then run the CLI with local coding tools:

```bash
npm run agent -- "Find and fix the failing test"
```

Switch models by editing the record with `editModel.js`, or by adding a second
entry to `MODELS` and pointing `PLATFORM_MODEL_PROVIDER` at it by name:

```bash
node model_scripts/seedModel.js
PLATFORM_MODEL_PROVIDER=fast npm run agent -- "Summarize src/core"
```

With no record, or a record missing `apiKey`, both entrypoints exit with a coded
error instead of falling back to another model or another credential.

Mutating tools request terminal approval. Filesystem operations are confined to
the current workspace, edits require a prior read, and interruption propagates
to active model streams and process trees.

After a build, the executable entrypoint is:

```bash
node dist/adapters/cli/index.js "Describe the harness"
```

## SDK

```ts
import {
  AllowAllPermissionHandler,
  createAgentSession,
  createBuiltinTools,
  LocalRuntimeHost,
  ScriptedModelProvider,
} from '@trueai/agent-harness';

const runtime = new LocalRuntimeHost(process.cwd());
const provider = new ScriptedModelProvider([
  [
    { type: 'text_delta', delta: 'Hello from the harness.' },
    { type: 'completed', stopReason: 'end_turn' },
  ],
]);

const session = createAgentSession({
  provider,
  workingDirectory: process.cwd(),
  tools: createBuiltinTools(runtime),
  permissionHandler: new AllowAllPermissionHandler(),
});

for await (const event of session.run({ prompt: 'Say hello' })) {
  console.log(event.type, event);
}

await session.close();
```

The control surface also supports `interrupt(reason)`,
`respondToPermission(requestId, decision)`, persistent resume through
`resumeAgentSession`, and clean resource release through `close()`.

## Web tools

`createWebTools()` adds two opt-in network tools alongside the workspace tools.
They are a separate factory from `createBuiltinTools`, so existing
workspace-only sessions keep exactly the tools they had.

```ts
import { createBuiltinTools, createWebTools, LocalRuntimeHost } from '@trueai/agent-harness';

const runtime = new LocalRuntimeHost(process.cwd());
const tools = [...createBuiltinTools(runtime), ...createWebTools()];
```

- `web_fetch` retrieves one http(s) URL and returns readable text. HTML is
  converted without extra dependencies, `http` is upgraded to `https`, responses
  are cached for 15 minutes, and content is bounded by bytes, characters, and a
  request timeout. Pass a `summarize` hook to reduce pages with a model instead
  of returning the extracted text.
- `web_search` returns bounded, cited hits through a pluggable
  `WebSearchProvider`. It registers only when a provider is available; the
  default Tavily backend activates when `TAVILY_API_KEY` is set.

Both report `kind: 'network'`, so the default and rule permission handlers ask
before running them, and `plan` mode denies them. Results carry an explicit
untrusted-content notice.

Security boundaries enforced before any request leaves the process: non-public
hosts refused (loopback, link-local, private ranges, IP literals, and
`.local`/`.internal`-style names), URLs with embedded credentials refused,
non-http(s) schemes refused, and cross-site redirects reported to the model
rather than followed. `allowedHosts`, `blockedHosts`, and `allowPrivateHosts`
let an operator narrow or widen that policy.

## Other consumers

- `runJsonlAdapter` provides line-delimited commands and events for automation.
- `startAgentSseServer` is the minimal stateless HTTP/SSE example.
- `SessionGateway` plus `startGatewayServer` adds authenticated ownership,
  control tokens, permission responses, interruption, replay, idempotent run
  IDs, and artifact transfer.
- `DesktopAgentAdapter` and `IdeAgentAdapter` translate surface context into the
  shared gateway protocol.
- `RemoteRuntimeHost` exposes only capabilities implemented by a trusted
  `RuntimeRpcServer`.

See [examples/sdk/basic.ts](./examples/sdk/basic.ts) and
[examples/server/basic.ts](./examples/server/basic.ts).

## Standalone agent-core service demo

Run the harness as an independent API service without a frontend:

```bash
# terminal 1
npm run service

# terminal 2
npm run demo:client -- "Demonstrate the API"
```

The deterministic demo exercises session creation, SSE streaming, a remote
permission response, a real workspace tool, event replay, persistence, and
session close. See the [service demo runbook](./docs/agent-core-service-demo.md)
for endpoints, environment configuration, security notes, and OpenRouter mode.

## MongoDB agent platform

The platform layer stores tenant-scoped agents, immutable executable versions,
deployments, API-key hashes, sessions, run claims, events, skills, data bindings,
policies, and limits in MongoDB. It executes deployed agents synchronously in
the API process; queue and worker dispatch are intentionally deferred.

```bash
MONGODB_URI='mongodb://127.0.0.1:27017' \
PLATFORM_BOOTSTRAP_API_KEY='replace-me' \
PLATFORM_BOOTSTRAP_TENANT='tenant-a' \
PLATFORM_SECRET_TENANT_A__OPENROUTER_API_KEY='...' \
npm run platform
```

See the [MongoDB platform runbook](./docs/platform.md) for the complete data
model, API workflow, provider configuration, authentication, capability trust
boundary, and future worker handoff.

The [Web Research Agent demo](./docs/web-search-agent-demo.md) shows how a
versioned agent retrieves its model, search tool, skill, permissions, and limits
from MongoDB, then answers a live question with cited Tavily sources.
Its [live acceptance result](./docs/web-search-agent-live-result.md) records the
successful Atlas/OpenRouter/Tavily trajectory and model fallback evidence.

## Included harness capabilities

- provider-neutral streaming model contract, an OpenRouter adapter with live
  model-catalog resolution and routing fallbacks, a generic OpenAI-compatible
  adapter, retry policy, and a deterministic scripted provider;
- schema-validated tools with serial/explicitly-safe parallel execution;
- workspace-scoped read, glob, grep, write, edit, and shell tools;
- allow/ask/deny permission rules and plan/default/bypass/deny modes;
- opt-in `web_fetch` and `web_search` network tools with SSRF-resistant URL
  policy, redirect containment, bounded results, and pluggable search backends;
- context budgeting, reactive prompt-too-long compaction, usage events, large
  result artifacts, file-backed sessions, resume, and transcript exports;
- typed hooks, layered configuration, commands, skills, trusted plugins, and
  explicit plugin capability grants;
- MCP client/server integration over stdio or streamable HTTP;
- background shell/subagent tasks, quotas, cancellation, and team coordination;
- optional secrets, metrics, structured logs, notifications, diagnostics,
  budgets, rate limiting, and version discovery.

## Architecture and migration evidence

- [Migration plan](./MIGRATION_PLAN.md)
- [Completion audit](./COMPLETION_AUDIT.md)
- [Platform completion audit](./PLATFORM_COMPLETION_AUDIT.md)
- [Feature parity checklist](./PARITY_CHECKLIST.md)
- [Event protocol](./docs/protocols/events.md)
- [Threat model](./docs/security/threat-model.md)
- [Compatibility and rollout](./docs/migration-compatibility.md)
- [Clean-room rules](./CLEAN_ROOM.md)

The former `claude-code` tree is a behavioral reference only. It is not imported,
linked, packaged, or required at runtime.

# Agent Console

Agent Console is a React + HeroUI + Express control plane for agents hosted on Amazon
Bedrock AgentCore Runtime. It manages the existing `trueai_agent_platform` records in MongoDB,
resolves their referenced model provider, MCP servers, and skills, invokes the deployed
runtime, and renders saved chats and runs in the browser.

```text
browser -> Express API -> MongoDB
                       -> bedrock-agentcore:InvokeAgentRuntime -> S3 (referenced skills)
```

By default every run uses the global `AGENTCORE_RUNTIME_ARN`; the complete resolved
agent definition is sent in the payload. Setting `LOCAL_HARNESS_URL` switches every
run to a plain HTTP POST of that same payload against a harness process on this
machine instead — no ARN, no AWS credentials — see [Configuration](#configuration).
The runtime image is in [agent-harness-clone](../agent-harness-clone).

## Data model

The console reads and writes the historical platform collections in place:

- `agents` stores the agent definition and string ObjectId references:
  `modelProviderId`, ordered `mcpServerIds`, and ordered `skills[].skillId` entries.
  It also carries the explicit tool allowlist, `stream` response preference, and
  deterministic context limits such as `compactionThresholdPercent`.
- `model_providers` stores model configuration, its API credential, and the latest
  server-discovered USD rate card for the selected model.
- `mcp_servers` stores stdio or HTTP MCP configuration and its credentials,
  environment, and headers.
- `skills` stores skill metadata and an S3 URI for the full skill document.

It adds two console collections in the same database:

- `chats` stores conversation messages, a stable AgentCore runtime session ID, and
  the latest deterministic context-usage snapshot and bounded inspection timeline.
- `runs` stores invocation status, output, usage, an immutable cost/rate snapshot,
  tool counts, timing, AgentCore metadata, and any context-management action reported
  by the runtime. A chat-originated run also has a `chatId`.

The intended database is `trueai_agent_platform`. A pathless MongoDB URI falls back to
that database rather than MongoDB's implicit `test` database. `MONGODB_DB_NAME` overrides
the database in the URI. The server does not copy records into a dedicated console
schema and does not reject the historical reference layout.

### Invocation resolution

For each invocation the API:

1. Loads the enabled agent and dereferences its model provider, MCP servers, and skills.
2. Validates that referenced resources are present, enabled, and compatible with the
   deployed harness.
3. Preserves stored skill and MCP order and sends each skill as
   `{ name, uri, allowedTools? }` without downloading or inlining its document.
4. Creates a `running` run row and makes one `InvokeAgentRuntime` call.
5. Saves the returned result or the translated invocation error.

Skill URIs may use `s3://...` or an uncredentialed AWS S3 HTTPS object URL. The runtime
downloads referenced documents into execution-scoped temporary storage and removes
them after execution, so S3 access belongs to the runtime role rather than the console.

Model credentials come only from the referenced `model_providers` record. Agents do not
carry inline API keys and there is no environment-key fallback. The deployed harness
accepts `openrouter`, `nvidia`, `bedrock`, and `openai-compatible` provider identities
with bearer authentication. NVIDIA NIM and Amazon Bedrock's OpenAI-compatible
Runtime/Mantle endpoints use the common chat-completions adapter while retaining their
identity for model and price discovery.

### Automated usage cost

The model-provider form has **Fetch models & pricing**. The server calls that
provider's `/models` endpoint, returns the routable model IDs, and attaches token
limits, capabilities, and pricing when available. OpenRouter rates come directly from
its model catalogue. Bedrock availability comes from its regional OpenAI-compatible
endpoint and is joined by exact model ID to the cached LiteLLM rate catalogue (whose
rows link back to their pricing source). NVIDIA's public hosted developer endpoint is
marked as zero-cost prototyping; self-hosted or contract-priced NIM endpoints remain
unpriced unless their API reports a charge.

At run completion the console uses this precedence:

1. Provider-reported request cost, when present (the billing authority).
2. A local estimate from the selected model's saved input/output/cache/reasoning rate
   snapshot.
3. Explicitly `Unpriced` when neither exists. It never borrows another model's rate.

Every run retains the rate snapshot used, so later catalogue price changes do not
rewrite history. Run lists and details show the charge and calculation method; chat
shows each turn's cost and the running session total. These are inference charges,
not infrastructure, AgentCore, network, or enterprise-license costs.

## Run it

Requirements:

- Node.js 22 or newer.
- Access to the `trueai_agent_platform` MongoDB database.
- A deployed AgentCore runtime and AWS credentials allowed to call
  `bedrock-agentcore:InvokeAgentRuntime` on it.
- `s3:GetObject` access from the runtime role to referenced skill objects when skills
  are used.

Copy `server/.env.example` to `server/.env`, then run:

```bash
cd agent-console
npm run install:all
npm run dev
```

Development runs the API on `http://127.0.0.1:4000` and Vite on
`http://localhost:5173`; Vite proxies API requests to Express.

For a single-process production build:

```bash
npm run build
npm start
```

Express then serves `client/dist` and `/api` from `http://127.0.0.1:4000` by default.
Run `npm test` for the server test suite. `npm run seed` is optional and writes example
records into the configured database, so check the resolved database before using it.

To build the supplied runtime image for AgentCore's architecture:

```bash
cd ../agent-harness-clone
docker buildx build --platform linux/arm64 -t agent-harness:latest .
```

Push the image to ECR and deploy it through AgentCore, then configure its runtime ARN in
the console. Leave `AGENT_SERVICE_KEY` unset in that deployment: AgentCore authenticates
the SDK invocation and does not forward that custom local-service header.

## Console UI

The browser app is React 18 on Vite, built from [HeroUI](https://heroui.com) components
over Tailwind CSS. Structure is unchanged from the plain-CSS version — one route per
screen under `client/src/pages`, shared pieces in `client/src/components` — and the
API client is untouched.

- `client/src/components/Bits.jsx` holds the shared primitives every page composes:
  `PageHeader`, `SectionCard`, `StatTile`, `MetaGrid`, `EmptyState`, `ToggleCard`,
  `FormActions`, and the date/token formatters. `ResourceRow.jsx` is the one row shape
  the model, MCP, and skill lists share; `MapEditor.jsx` is the header/environment and
  argument editor the two credentialed forms share.
- `useConfirm()` replaces `window.confirm` for destructive actions, so a delete asks in
  a themed dialog instead of a browser modal that blocks the tab.
- Light and dark are both first-class. `client/src/theme.jsx` owns the class on `<html>`,
  seeds it from the OS setting, persists the operator's choice, and a small inline script
  in `index.html` applies it before React mounts so a reload does not flash white.
- Theme colours live in `client/tailwind.config.js` as a single brand ramp fed to the
  `heroui()` plugin, not as scattered hex values.
- Context management appears as a compact live meter in chat and a detailed inspector
  on saved chats and runs. It shows measured usage, the deterministic action taken,
  compaction history, and verification/recovery outcomes without inventing retrieval,
  grounding, memory, or quality claims.

One installation detail matters: Tailwind must scan `@heroui/theme` or every HeroUI
component renders unstyled. That package is a transitive dependency, so the `content`
globs list both the hoisted and the nested location. If you change package manager and
components lose their styling, that glob is the thing to check.

## Configuration

| Variable                | Purpose                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `HOST`                  | API bind address; defaults to `127.0.0.1`.                                         |
| `PORT`                  | Express port; defaults to `4000`.                                                  |
| `CORS_ORIGIN`           | Comma-separated browser origins; defaults to the Vite origin.                      |
| `MONGODB_URI`           | MongoDB or Atlas connection URI. Prefer an explicit `trueai_agent_platform` path.  |
| `MONGODB_DB_NAME`       | Optional database override; a pathless URI otherwise uses `trueai_agent_platform`. |
| `PLATFORM_CREATED_BY`   | Provenance stamped on records created by this console.                             |
| `AGENTCORE_RUNTIME_ARN` | Required global AgentCore runtime ARN used for every invocation.                   |
| `AGENTCORE_QUALIFIER`   | Optional runtime endpoint qualifier; unset uses `DEFAULT`.                         |
| `AWS_REGION`            | Deliberate region override; otherwise the runtime ARN supplies its region.         |
| `AWS_PROFILE`           | Optional shared-configuration profile for the standard AWS credential chain.       |
| `AGENTCORE_TIMEOUT_MS`  | SDK request timeout; defaults to 900,000 ms.                                       |
| `AGENT_RUNTIME_TOOLS`   | Comma-separated tool catalogue actually deployed in the runtime image.             |
| `LOCAL_HARNESS_URL`     | Optional. When set, every invocation is a plain HTTP `POST /invocations` to this URL (a harness run with `npm start`) instead of AgentCore — wins over `AGENTCORE_RUNTIME_ARN` unconditionally. Unset by default, so nothing about the AgentCore path above changes unless this is set. |
| `LOCAL_HARNESS_SERVICE_KEY` | Optional. Sent as `x-agent-service-key` when the local harness has `AGENT_SERVICE_KEY` set. |
| `LOCAL_HARNESS_TIMEOUT_MS` | Request timeout for the local transport; defaults to 900,000 ms, same reasoning as `AGENTCORE_TIMEOUT_MS`. |

An ambient environment variable wins over the value in `server/.env` because Node's
`--env-file-if-exists` does not replace an existing value. Startup prints the resolved,
redacted MongoDB target and database so this is visible before any write.

`/api/health` reports the MongoDB connection, resolved database, and either AgentCore
configuration/AWS credential readiness or local-harness reachability, whichever transport
`LOCAL_HARNESS_URL` selects.

## API

All success responses are JSON. Invalid request bodies return a structured `400`; a
referenced resource that cannot be deleted returns `409`.

### Discovery and dashboard

| Method | Path                     | Response                                                                                              |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`            | Database, AgentCore, and credential readiness.                                                        |
| `GET`  | `/api/catalogue`         | `{ tools, modelProviders, mcpServers, skills }`; resources are enabled and secrets are safe.          |
| `GET`  | `/api/dashboard`         | `{ dashboard: { counts, recentRuns, recentChats } }`; large run output and chat messages are omitted. |
| `GET`  | `/api/agents/meta/tools` | Runtime tool catalogue and supported model provider names.                                            |

Dashboard counts include `agents`, `modelProviders`, `mcpServers`, `skills`, and `chats`.

### Agents and runs

| Method                   | Path                      | Purpose                                                                                                                                                               |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`, `POST`            | `/api/agents`             | List or create agents. List supports `q` and `enabled`.                                                                                                               |
| `GET`, `PATCH`, `DELETE` | `/api/agents/:id`         | Read, update, or delete an agent. Detail includes resolved references plus run/chat counts.                                                                           |
| `POST`                   | `/api/agents/:id/preview` | Build the target and recursively redacted payload without invoking.                                                                                                   |
| `POST`                   | `/api/agents/:id/invoke`  | Invoke and return `{ run, events }`.                                                                                                                                  |
| `GET`                    | `/api/runs`               | List runs; supports `agentId`, `chatId`, `status`, `runtimeSessionId`, `limit`, and `sort=oldest`. List omits output and truncates prompt previews to 240 characters. |
| `GET`, `DELETE`          | `/api/runs/:id`           | Read a full run or delete its history row.                                                                                                                            |

Preview and invoke accept `{ prompt, runtimeSessionId?, permissionMode?, includeEvents? }`.
Agent deletion preserves existing chats and runs by default, matching their role as
history snapshots. `withRuns=true` also removes its runs; `withHistory=true` removes
both chats and runs before deleting the agent.

### Model providers, MCP servers, and skills

Each resource exposes list/create at its collection route and read/update/delete at
`/:id`:

| Resource        | Collection route       | List response               | Detail response                        |
| --------------- | ---------------------- | --------------------------- | -------------------------------------- |
| Model providers | `/api/model-providers` | `{ modelProviders, total }` | `{ modelProvider, referencedByCount }` |
| MCP servers     | `/api/mcp-servers`     | `{ mcpServers, total }`     | `{ mcpServer, referencedByCount }`     |
| Skills          | `/api/skills`          | `{ skills, total }`         | `{ skill, referencedByCount }`         |

Lists accept `q` and `enabled`. A model provider, MCP server, or skill cannot be deleted
while an agent references it.

`POST /api/model-providers/discover` accepts draft `{ provider, baseURL?, apiKey?,
modelProviderId? }` connection details and returns a normalized live model catalogue.
On edit, `modelProviderId` lets the server reuse the stored key without returning it to
the browser.

Secret values are never returned by these APIs:

- Model-provider responses omit `apiKey` and header values and instead return
  `hasApiKey`, `hasHeaders`, and `headerNames`.
- MCP responses omit `apiKey`, environment values, and header values and instead return
  `hasApiKey`, `hasEnv`, `envKeys`, `hasHeaders`, and `headerNames`.
- Agent payload previews recursively redact credentials and secret maps.

Provider and HTTP MCP endpoints must use HTTP(S) and cannot contain URL userinfo, query
parameters, or fragments; credentials belong in the explicit auth/header fields. If a
legacy record already contains those unsafe URL components, list/detail responses strip
them and set `baseURLRedacted` or `urlRedacted` until the record is corrected.

PATCH requests deliberately distinguish "unchanged" from "clear":

- Omit a field to leave it unchanged.
- For `apiKey`, `""` preserves the stored value and `null` requests a clear. The merged
  record must still be valid, so a bearer-authenticated provider or HTTP MCP server
  cannot be left without the required key.
- For `env` and `headers`, an object replaces the map. An empty value for an existing
  key preserves that key's stored value; omitted keys are removed. `{}` or `null` clears
  the map, while `""` preserves the entire map.
- `baseURL` may be cleared with `""` or `null` where the provider remains valid.
- Transport-specific fields such as MCP `command`, `args`, `url`, and `wire` may be sent
  as `null` when switching modes so stale values are removed.

### Chats

Generated Markdown, HTML, DOCX, XLSX, and CSV response artifacts are available at
`GET /api/chats/:id/artifacts/:artifactId`; add `?download=true` for attachment
delivery.

| Method                   | Path                           | Purpose                                                                                                                                     |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`, `POST`            | `/api/chats`                   | List chats or create one with `{ agentId, title? }`. List supports `agentId` and `limit`.                                                   |
| `GET`, `PATCH`, `DELETE` | `/api/chats/:id`               | Read messages, rename with `{ title }`, or delete. `withRuns=true` also deletes linked runs.                                                |
| `POST`                   | `/api/chats/:id/messages`      | Send `{ content, permissionMode?, includeEvents? }`; returns `{ chat, run, events }`, or an SSE event stream — see [Streaming](#streaming). |
| `POST`                   | `/api/chats/:id/session/reset` | Start fresh runtime context while retaining visible messages.                                                                               |

Each chat keeps one runtime session ID. The harness persists the canonical model
transcript and the console sends the latest user prompt unchanged. The console also sends
a typed, bounded recovery history from MongoDB. With the harness S3 store enabled, a
cold runtime restores the complete model/tool transcript from S3; MongoDB history is the
final fallback only when no durable S3 session exists. Context recovers without
duplicating turns. Error messages and pre-reset messages are excluded. An atomic chat
lease refuses overlapping turns with HTTP 409 instead of racing transcript writes.

The chat header exposes the runtime state and storage backend, including an
`S3 session active` indicator, and provides a context reset. Reset retains the visible transcript
for auditability while starting a new context generation.

## AgentCore behavior

One runtime deployment serves every stored agent. `AGENTCORE_RUNTIME_ARN` is global;
there is no per-agent runtime ARN. The region is derived from that ARN unless an AWS
region override is explicitly configured.

Each user invocation produces one AWS SDK request with `maxAttempts: 1`. There is no
automatic retry because repeating an agent turn can duplicate side effects and spend
tokens twice. A caller may choose to retry after reviewing the recorded failure.

A run row is created before AgentCore is called. A result returned by the harness, including a
turn-level `status: "error"`, is persisted as a completed runtime result. An AWS transport,
authorization, throttling, timeout, or service failure is translated to an API error and
recorded on the run.

The non-streaming timeout defaults to AgentCore's 15-minute cap. A streamed run has
60 minutes at the runtime, but `AGENTCORE_TIMEOUT_MS` still applies to the SDK request,
so raise it past 900,000 before relying on the longer ceiling.

## Streaming

An agent carries a `stream` flag, off by default, which is the console's own default for
that agent rather than a switch on the wire. Saving it against a model provider whose
`capabilities.supportsStreaming` is `false` is rejected, and an existing mismatch is
reported as a `MODEL_PROVIDER_NO_STREAMING` readiness issue.

Which encoding a request actually uses is decided the same way at every hop — the caller
states it, and the stored preference only answers for a caller that stated nothing:

| Hop                                       | Streams when                                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Browser to `POST /api/chats/:id/messages` | `Accept: text/event-stream` or `?stream=true`; otherwise the agent's `stream` flag                        |
| Console to `InvokeAgentRuntime`           | The console asked for a stream; `accept: text/event-stream` then outranks `payload.stream` at the runtime |

A streamed message answers with SSE frames carrying the runtime's `AgentEvent` protocol
verbatim — `run.preparing`, `assistant.reasoning.delta`, `assistant.text.delta`,
`tool.input.delta`, `tool.progress`, `usage.updated`, `warning` — and finishes with one
of two events this layer adds: `console.completed`, carrying the saved chat and run, or
`console.failed`. The chat page renders thinking, tool cards with live output, and the
answer as it arrives; a buffered agent takes the unchanged JSON path.

Streaming does not change what is stored. The events are folded into the same result the
buffered path receives (`RunTotals`) and written through the same code, so a run row does
not depend on how it was invoked. Two consequences worth knowing: `workingDirectory` is
empty on a streamed run because no event carries it, and a stream that ends without
`session.completed` is recorded as `RUNTIME_STREAM_INCOMPLETE` with whatever partial
output arrived. Closing the browser aborts the AgentCore call rather than leaving the run
to finish unwatched.

Resuming a dropped stream and answering an interactive permission request are runtime
features this console does not use yet; both need it to hold a run id across requests.

## Generated file responses

The console understands the harness's Markdown, HTML, Word, Excel, and CSV response
paths in both buffered and streaming mode. In production the harness first uploads the generated object
to the existing private `AGENT_SESSION_S3_BUCKET` under `AGENT_S3_ARTIFACT_PREFIX`, then
emits `artifact.created` with its structured S3 reference. MongoDB stores that durable
reference and display metadata, not a second copy of the file and never a temporary
presigned URL.

Chat JSON contains only artifact metadata and console preview/download URLs; the full
Artifact bytes are returned only by the console-owned artifact endpoint, which resolves the
owning chat and proxies checksum-aware `GetObject` from the allowlisted bucket and
prefix. Keep this endpoint behind the console's authentication/front door in production. The console role therefore
needs `s3:GetObject` only for the artifact prefix; the runtime role needs `s3:PutObject`.
Keep the shared bucket private and use an S3 lifecycle rule for retention/orphan cleanup.

Existing and local-development Markdown, HTML, and CSV artifacts that contain a MongoDB
`content` field remain readable. Binary DOCX/XLSX files require shared S3 storage. In the chat UI, generated files
appear as document cards and any separate assistant narrative remains visible above them.
During a streamed write, its artifact workspace opens automatically. Markdown, HTML, and
Word source update as text arrives; structured spreadsheet previews appear once their tool
input is complete. The workspace provides format-aware controls (Preview/Code, Table/Raw,
Word pages, or worksheet tabs), then switches to the saved S3-backed artifact when the turn
finishes. Closing the workspace during a turn is respected; it does not repeatedly reopen.

Tool activity is also part of the saved assistant message. Live calls appear in an expanded
activity group, while completed messages keep the same calls in a collapsed dropdown. Opening
Tools reveals a concise call list; each call then expands independently to show its bounded
input and output. Provider-exposed reasoning follows the same lifecycle in a separate Thinking
disclosure: open while streaming, collapsed after the response is saved. The console correlates
tool requests and results for the current turn only, applies field-size and call-count bounds
before persistence, and removes generated document bodies and spreadsheet cell data from
artifact-tool inputs because S3 is the canonical file store. Selecting a file card reopens
the same workspace, and its download action returns the original generated file. HTML preview
runs in a scriptless sandbox; direct HTML and Office-file responses are attachment-only.

## Troubleshooting

- **Unexpected database:** check the first startup line and your ambient
  `MONGODB_URI`/`MONGODB_DB_NAME`; shell variables override `server/.env`.
- **Runtime not found:** confirm the ARN and qualifier, then check that the SDK region is
  the ARN's region. A deliberate `AWS_REGION` override can point at the wrong region.
- **Skill cannot load:** verify the URI names an AWS S3 object and grant the AgentCore
  runtime role `s3:GetObject` for it.
- **A Node launcher receives an HTTP URL as its entry/package:** this occurs when a
  stdio MCP record puts an endpoint URL where `node` expects a local module or where
  `npx`, `npm`, `yarn`, or `pnpm` expects a package/command. Configure an endpoint as
  `transport: "http"` with `url`, or pass the real package and every launcher option as
  separate arguments. A URL may still be a normal application argument after a valid
  package entry.

## Security

The API has no authentication or multi-tenancy. It binds to loopback by default. CORS is
not access control; before exposing the service, put authenticated authorization and TLS
in front of it. Anyone who reaches the API can modify shared platform definitions and
invoke tools in AgentCore with the runtime deployment's IAM identity.

Model and MCP secrets are hidden from list, detail, catalogue, and preview responses, but
they are stored in plaintext in MongoDB and are loaded into invocation payloads. Use
encryption at rest or a secrets manager before storing production credentials. Prompts,
outputs, and chat messages are also persisted and may contain sensitive data.

Grant the console only the MongoDB and `bedrock-agentcore:InvokeAgentRuntime` permissions
it needs. Restrict the runtime role separately according to the referenced S3 skills,
enabled tools, and MCP integrations.

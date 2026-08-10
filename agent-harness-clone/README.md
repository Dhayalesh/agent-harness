# Agent Harness

A headless TypeScript agent runtime for Node.js. One mode, one contract: post a
payload, get a run.

Everything a run needs is named on the request — the system prompt, the model and its
credential, the tools, the MCP servers, and an S3 URI for each skill. The process opens
no database and holds no stored agent configuration. When a payload references skills,
the runtime reads those objects during preparation, so any replica serving the request
needs the same IAM access to them.

```
POST /invocations               payload in, result or SSE event stream out
POST /invocations/permissions   answers a suspended run's permission request
GET  /ping                      health probe
```

That is the whole surface. There is no CLI agent, no session gateway, no desktop or
IDE adapter, and no `agents` collection: an earlier version of this repository had all
of them, and they are gone rather than deprecated.

## Requirements

- Node.js 22 or newer
- npm
- AWS SDK credentials only when using S3-backed skills or direct CloudWatch delivery

No MongoDB and nothing to seed before the first run. AWS credentials are ambient, not
part of the payload: AgentCore should use its execution role, while local runs can use
the SDK's normal environment, shared config, or profile providers. A run with no skills
does not read S3.

## Install and verify

```bash
npm install
npm run check
npm run build
```

`npm run check` verifies formatting, TypeScript, and the test suite. The tests need no
credentials: a local HTTP server plays the model, so a full turn runs for real —
executing tools and writing files — with nothing external.

## The payload

```json
{
  "prompt": "Summarise what changed in this repository.",
  "agent": {
    "name": "reviewer",
    "systemPrompt": "You are a concise analyst.",
    "tools": ["read_file", "glob", "grep", "bash"],
    "limits": { "maxTurns": 12 }
  },
  "modelProvider": {
    "name": "openrouter",
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4.6",
    "apiKey": "sk-or-..."
  },
  "skills": [
    {
      "name": "repository-review",
      "uri": "s3://company-agent-skills/repository-review/v1/SKILL.md",
      "allowedTools": ["read_file", "glob", "grep"]
    }
  ],
  "permissionRules": [
    { "tool": "read_file", "decision": "allow" },
    { "tool": "skill", "decision": "allow" }
  ],
  "permissionFallback": "deny"
}
```

`agent`, `modelProvider`, and `prompt` are required; everything else has a default.
`mcpServers` are inlined with their connection details and credentials. A skill is a
small reference shaped as `{ "name": "...", "uri": "s3://bucket/key",
"allowedTools": ["..."] }`; `allowedTools` is optional and, when present, must be a
subset of `agent.tools` and overrides the list in that skill's front matter. The
payload never carries the `SKILL.md` body or an AWS credential. Omitting `agent.tools`
offers every tool the host built.

Every object is strict: an unrecognised key is a rejected payload, not a silently
ignored one, because a misspelled `systemPrompt` that runs anyway is worse than one
that fails. The full annotated contract is
[src/headless/payload.ts](./src/headless/payload.ts), and a working file is
[examples/headless/payload.json](./examples/headless/payload.json).

Note the shape of the trust boundary. A payload chooses the system prompt, the model
endpoint its credential is sent to, the MCP servers — including stdio ones that spawn
processes — and the permission mode. Anyone who can post one has code execution on the
host. Stored records at least had an operator script in front of them; a payload has
whatever the transport put there.

## Run it

Three ways, same code underneath.

```bash
# A payload file, printed as one result
npm run payload -- payload.json

# The same, streaming events as JSON lines
npm run payload -- payload.json --stream

# The server
npm start
```

```bash
curl -X POST http://127.0.0.1:8080/invocations \
  -H 'content-type: application/json' \
  -H 'x-agent-service-key: <key>' \
  --data-binary @payload.json
```

Add `Accept: text/event-stream` or `?stream=true` for SSE, or `?stream=false` /
`Accept: application/json` to insist on a buffered result.

A payload may also carry `stream: true`, which is consulted only when the transport
stated nothing — an `Accept: */*` from a caller whose agent definition is the thing that
knows it streams. An explicit `Accept` still wins, because that header is what the caller
can actually read and a body must not be able to make it read something else.

## Configuration

Copy the annotated template and fill in what you need:

```bash
cp .env.example .env
```

Nothing in it configures an agent. Every variable is optional, and what they set is
where the process listens and what it will allow a payload to do:

| Variable                                    | Effect                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| `AGENT_SERVICE_HOST` / `AGENT_SERVICE_PORT` | Where the listener binds. Defaults `0.0.0.0:8080`.            |
| `AGENT_SERVICE_KEY`                         | Required in `x-agent-service-key` when set.                   |
| `AGENT_WORKSPACE`                           | Parent of the per-invocation workspace.                       |
| `AGENT_PERMISSION_CEILING`                  | `plan`, `deny`, or `none`. Caps what any payload may ask for. |
| `AGENT_SHELL_ENV_ALLOWLIST`                 | Extra variables spawned commands may see.                     |
| `TAVILY_API_KEY`                            | Backend for `web_search`. Unset omits that one tool.          |
| `AGENT_LOG_GROUP`                           | Direct CloudWatch group. Set `-` for stdout only.             |
| `AGENT_LOG_LEVEL`                           | `debug`, `info`, `warn`, or `error`. Defaults to `info`.      |
| `AWS_REGION`                                | SDK region for CloudWatch, skills, and session S3 access.     |
| `AGENT_SESSION_STORE`                       | `file` (default), `s3`, `memory`, or `none`.                  |
| `AGENT_SESSION_DIR`                         | Directory for atomic session files. Defaults under OS temp.   |
| `AGENT_SESSION_TTL_SECONDS`                 | Inactive transcript lifetime. Defaults to 24 hours.           |
| `AGENT_SESSION_MAX_BYTES`                   | Per-session size limit. Defaults to 10 MiB.                   |
| `AGENT_SESSION_S3_BUCKET`                   | Durable bucket; required when the store is `s3`.              |
| `AGENT_SESSION_S3_PREFIX`                   | Object prefix. Defaults to `sessions`.                        |
| `AGENT_SESSION_S3_REQUEST_TIMEOUT_MS`       | S3 operation timeout. Defaults to 10 seconds.                 |

Leaving `AGENT_SERVICE_KEY` empty serves an unauthenticated endpoint. The process warns
on stderr at startup when it is, and that is appropriate only behind a front door that
authenticates for you — an AgentCore runtime, an API gateway, or a loopback bind.

`AGENT_PERMISSION_CEILING` is how a shared deployment takes back the permission
decision: a payload can set `permissionMode: "bypass"`, and the ceiling overrides it.

## Deploy on AWS

The image serves the AgentCore Runtime contract on 8080, so it drops in with no
adapter. ARM64 is required by the runtime, so the platform is pinned rather than left
to the builder — an amd64 image builds and pushes without complaint and then fails to
start.

```bash
docker buildx build --platform linux/arm64 -t agent-harness:latest .
```

Set `AGENT_PERMISSION_CEILING` and `AGENT_SERVICE_KEY` for a deployment more than one
caller reaches. If payloads reference skills, attach an execution role that can read
only the approved skill prefix. The runtime uses `GetObject`; it does not need S3 write
access for this flow:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadAgentSkills",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::company-agent-skills/approved/*"
    }
  ]
}
```

The AWS SDK resolves credentials from the AgentCore execution role and resolves the
region normally. Set `AWS_REGION` when it cannot infer the intended region; the legacy
`PLATFORM_CONTENT_S3_REGION` value is accepted as a fallback.

When S3 session persistence is enabled, grant a separate bucket/prefix rather than
adding write access to the skill bucket. For example:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListSessionPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::company-agent-sessions",
      "Condition": {
        "StringLike": { "s3:prefix": ["production/sessions/*"] }
      }
    },
    {
      "Sid": "ManageSessionObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::company-agent-sessions/production/sessions/*"
    }
  ]
}
```

Block public access, enable bucket versioning if rollback is required, expire noncurrent
versions, and configure a lifecycle expiration for the approved retention period. Raw
SAP exports should remain artifacts; store only bounded tool results and summaries in
the conversation session.

### CloudWatch and end-to-end logs

The server writes structured JSON lines to stdout, which AgentCore collects into its
runtime log stream. Unless `AGENT_LOG_GROUP=-`, it also uses the AWS SDK to deliver the
same records to the configured group. That writer and S3 skill loading both use the
host's ambient credentials rather than credentials from an invocation.

Those are two destinations for the same logical records. A Logs Insights query that
selects both the AgentCore runtime group and the direct group will therefore show each
`invocationId` + `logSequence` pair twice. Query one group, or set
`AGENT_LOG_GROUP=-` to use only the stdout stream. When intentionally combining both
groups, treat that pair as the record identity.

Logging is enabled by default. Each JSON record has a stable, readable envelope:
`timestamp`, `level`, `category`, `event`, `message`, `outcome`, `component`,
`schemaVersion`, and a monotonic `logSequence`. The default `info` level records concise
lifecycle milestones and size/count summaries, not raw prompts, token deltas, model
responses, tool inputs/results, MCP bodies, or repeated full tool catalogs. Set
`AGENT_LOG_LEVEL=debug` temporarily when reproducing a run to include those redacted
details.

The normal lifecycle is explicit rather than inferred from large payloads. Depending on
the run, it includes records such as:

```text
invocation.started
invocation.payload.validated
skill.materialization.completed
skill.load.completed
model.request.started
tool.execution.started
mcp.request.started
mcp.request.completed
tool.execution.completed
output.completed
invocation.cleanup.completed
invocation.completed
```

Failures and permission denials produce a terminal `*.failed` or `*.denied` record even
when a tool never begins execution. Every invocation record carries an `invocationId`;
HTTP runs also carry a `requestId`, the AgentCore `runtimeSessionId`, and the AWS
`traceId` when those headers are present. The chain adds `sessionId`, `turnId`,
`modelRequestId`, `toolCallId`, and `mcpRequestId` as each operation begins.

For example, use the invocation id from `http.request.started` to reconstruct a run in
CloudWatch Logs Insights:

```text
fields @timestamp, logSequence, level, event, message, outcome, sessionId, turnId,
  modelRequestId, toolCallId, mcpRequestId, durationMs
| filter invocationId = <invocation-id>
| sort logSequence asc
```

Payloads, MCP headers, tool arguments, and model output can contain secrets. Before any
record is written, credential-shaped keys and token patterns are replaced with
`[redacted]`; diagnostic error `code` values and normal token-usage counters remain
visible. Records larger than one CloudWatch-safe line are emitted as ordered
`log.chunk` records with `chunkId`, `chunkIndex`, `chunkCount`, and the original
correlation IDs so a debug record can be reassembled without losing its trace.

Each invocation gets its own workspace directory named for the session, so concurrent
payloads cannot read each other's files. Directories are not deleted: a run's output is
often the files it wrote, and the path comes back on the result so the caller can
collect them. Sweep `AGENT_WORKSPACE`, or mount it on a volume with its own lifecycle.

## Migrating from stored agents

If you have agents in a MongoDB `agents` collection from a previous version,
`scripts/headless/exportPayload.ts` converts one into a payload file. It reads the four
old collections and copies each skill's `name`, `uri`, and optional per-agent
`allowedTools` override. It does not contact S3 or download the skill documents:

```bash
npm run export-payload -- --agent sap-documentation-agent --out payload.json
npm run payload -- payload.json
```

It is the only thing left in the repository that opens a database, and it is
deliberately standalone so deleting it removes the last MongoDB dependency in one step.
Only `PLATFORM_MONGODB_URI` is needed by the exporter. Its output is intentionally not
self-contained: a run of the exported payload reads the current object at each URI and
therefore needs the same S3 access as any other skill-bearing invocation.

The output holds the model credential and every MCP credential in cleartext, because
that is what a payload is. `payload.json` and `payload.*.json` are gitignored; treat one
like a `.env`.

## SDK

The runtime is usable directly, without the HTTP layer:

```ts
import { invokeHeadless, streamHeadless } from '@trueai/agent-harness';

const result = await invokeHeadless(payload);
console.log(result.status, result.output, result.usage);

for await (const event of streamHeadless(payload)) {
  console.log(event.type, event);
}
```

`S3ContentStore` is the exported read/write adapter for operator-side content flows or
an embedding host. It uses the same ambient SDK identity and enforces the configured
timeout and byte ceiling:

```ts
import { S3ContentStore } from '@trueai/agent-harness';

const skills = new S3ContentStore({
  bucket: 'company-agent-skills',
  region: 'us-east-1',
  requestTimeoutMs: 15_000,
  maxObjectBytes: 2_000_000,
});

await skills.write('repository-review/v2/SKILL.md', markdown);
const loaded = await skills.load('repository-review/v2/SKILL.md');
skills.destroy();
```

That adapter is a host API, not a model-callable tool. The runtime's execution role
should normally remain read-only; use a separate operator identity for uploads.

`invokeHeadless` returns the answer with what it cost: the concatenated assistant text,
the messages, per-tool call and error counts, the stop reason, token usage, and the
workspace path. A failure _inside_ the turn comes back as `status: 'error'` on a result
that still carries the partial output, because a run that spent tokens and then hit a
model error has produced something worth seeing. Only a payload the runner could not act
on throws.

`streamHeadless` yields `AgentEvent` verbatim — a versioned, serializable protocol, the
same one the SSE endpoint frames.

## What a stream shows

Enough to render a run as it happens rather than summarize it afterwards.

| Event                       | When                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `run.preparing`             | Workspace, agent assembly, each MCP connection, skill downloads |
| `session.started`           | Preparation is done and the first turn is beginning             |
| `assistant.reasoning.delta` | The model's deliberation, where it emits any                    |
| `assistant.text.delta`      | The answer, token by token                                      |
| `tool.input.delta`          | A tool call arriving argument by argument, before it can run    |
| `tool.requested/started`    | The assembled call, then the start of its execution             |
| `tool.progress`             | Output from a running tool, **while it runs**                   |
| `tool.completed`            | Its result                                                      |
| `permission.requested`      | A tool is waiting on a decision (`permissionFallback: 'ask'`)   |
| `usage.updated`             | Tokens so far, including `reasoningTokens`                      |
| `warning`                   | A retried request, a compaction, a rate limit waited out        |

Every event carries `protocolVersion`, `sessionId`, a timestamp, and a `sequence` that
runs unbroken from the first `run.preparing` to `session.completed` — which is what
makes `Last-Event-ID` mean something.

**Reasoning** is off unless asked for. The provider record's
`capabilities.supportsReasoning` decides whether the request asks for it, and
`wire.reasoningField` names the delta field when a gateway is unusual; unset reads both
`reasoning` and `reasoning_content`. Deliberation is kept on `AgentMessage.reasoning`,
beside `content` rather than inside it, so a past turn's thinking is never replayed to
the model as if it were the answer.

**Tool progress is live.** `bash` and `powershell` forward every output chunk as it
arrives, and MCP tools forward their progress notifications, so a command that runs for
five minutes reports for five minutes instead of printing its transcript at the end.

## Conversation sessions

Conversation context is persisted separately from stream reconnection. The production
entrypoint enables an atomic file-backed session store by default. Set
`AGENT_SESSION_STORE=s3` to make S3 authoritative and retain the same files as a warm
local cache. A cold AgentCore container loads `<prefix>/<sessionId>.json` from S3; a
warm one reads `AGENT_SESSION_DIR`. Durable writes complete before the cache is updated.

S3 writes carry `If-None-Match` for a new session and the last observed ETag in
`If-Match` for an update. A competing writer therefore receives retryable
`SESSION_CONFLICT` instead of silently overwriting a newer transcript. Objects are
explicitly encrypted with S3-managed server-side encryption (SSE-S3). Credentials
always come from the standard AWS SDK chain, normally the AgentCore execution role.
Session S3 access uses the same `AWS_REGION` as the other AWS clients.

Reusing `sessionId` (or the AgentCore runtime session header) resumes the transcript;
concurrent turns for the same ID receive HTTP 409. `AGENT_SESSION_TTL_SECONDS` applies
only to local files in S3 mode. Evicting that cache never deletes the durable object;
configure S3 Lifecycle and your chat-deletion workflow according to the SAP data
retention policy. The serialized object remains bounded by `AGENT_SESSION_MAX_BYTES`.

A payload may include `session: { mode: "persistent", history: [...] }`. This bounded,
typed text history is used only when no stored transcript exists, so a trusted console
can recover after a cold runtime without appending duplicate turns. Set `mode:
"stateless"` for an intentionally fresh invocation. The `session.started` event and
buffered result report `mode`, `resumed`, `origin`, and `historyMessageCount`.

## Resuming, and answering

Both need the server to hold a run after the request that started it, which it does not
do by default. `resumableRuns` turns it on:

```ts
await startHeadlessServer({ serviceKey, resumableRuns: true });
```

The trade is the one the stateless design exists to avoid — a reconnect or a decision
has to reach the process holding the run. Under AgentCore that already holds, because a
runtime session id is pinned to one container.

**Resuming.** A registered stream answers with `x-run-id`. Reconnect by POSTing to
`/invocations` with that `x-run-id` and a `Last-Event-ID`, and the stream continues from
the next event; the body is ignored, since the run already has the payload that started
it. Events are buffered per run (`maxBufferedEvents`, default 2000) and a run with no
reader is aborted after `resumeWindowMs` (default 60s). A caller that has fallen further
behind than the buffer is told so rather than silently resumed from a gap.

**Answering.** `permissionFallback: 'ask'` suspends the run on a `permission.requested`
event. Resolve it with:

```bash
curl -X POST http://127.0.0.1:8080/invocations/permissions \
  -H 'content-type: application/json' \
  --data '{"runId":"<x-run-id>","requestId":"<from the event>","decision":"allow"}'
```

`ask` is refused outright without both a stream and a registry, because an unanswerable
question hangs until the caller times out. The path sits under `/invocations` because
that is what an AgentCore runtime routes.

Long streams also write a `: keep-alive` comment frame every `keepAliveMs` (default 15s),
so a turn spent inside one slow tool does not read as a dead connection to whatever sits
between the caller and the container.

## Tools

`read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash`, `powershell`,
`todo_write`, `web_fetch`, `web_search`. A payload names the subset it wants.

Filesystem operations are confined to the workspace, edits require a prior read, and
shell commands are inspected before they run. `web_fetch` and `web_search` refuse
non-public hosts, URLs with embedded credentials, and non-http(s) schemes, and report
cross-site redirects to the model rather than following them.

Plan mode and `ask_user_question` are deliberately absent. Both need someone watching:
plan mode is a review step before a human approves, and a question suspends the turn
until one is answered. A payload on its own is answered by nobody, so offering either
would produce a run that stalls or that silently picks an option on the caller's behalf.

`permissionFallback: 'ask'` is the one place that changes, and only where the watching
is real: a stream to show the question and a registry to route the answer back. Without
both it is refused rather than downgraded — see [Resuming, and answering](#resuming-and-answering).

Skills arrive as `{ name, uri, allowedTools? }` references. During preparation the
runtime issues `GetObject`, writes each complete `SKILL.md` into a private per-run
temporary directory in the layout a local skill directory uses, and parses it through
the normal skill loader. That directory is removed when the run ends, on the handled
failure path as much as the success one; skill bodies are not retained in the payload
or the run workspace.

An S3 URI names a mutable object, not immutable content. The runtime reads it fresh on
every run, so overwriting that key changes the instructions without changing the
payload. Prefer versioned, write-once keys such as `skills/reviewer/v3/SKILL.md`, and
treat permission to write those objects as permission to change agent behavior. Because
a caller chooses the bucket and key, scope the execution role's `s3:GetObject` resource
to approved buckets and prefixes; the IAM policy is the boundary, not the URI schema.

## Architecture

The invocation path is five files:

- [`payload.ts`](./src/headless/payload.ts) — the contract, as zod schemas
- [`inline-agent.ts`](./src/headless/inline-agent.ts) — payload to assembled agent
- [`invoke.ts`](./src/headless/invoke.ts) — the run, buffered or streamed
- [`server.ts`](./src/headless/server.ts) — the HTTP surface
- [`run-registry.ts`](./src/headless/run-registry.ts) — the optional state resuming
  and answering need, and nothing else

`inline-agent.ts` is the interesting one. Rather than building a session directly, it
completes the payload's blocks into the record shapes `PlatformAgentRegistry` already
validates and synthesizes the references they use to point at each other. The agent is
then assembled by the same code path a stored agent went through, which is why the
support gates, the limit derivation against the provider's context window, the skill
front-matter parsing, and the `mcp__<server>__<tool>` namespacing all still apply. One
assembly path, not two that drift.

See [CLEAN_ROOM.md](./CLEAN_ROOM.md) for the provenance rules. The former
`claude-code` tree is a behavioral reference only: it is not imported, linked,
packaged, or required at runtime.

## Limits worth knowing on AgentCore

These are the runtime's, not this application's, and two of them shape how you invoke
it:

| Limit                            | Value                    |
| -------------------------------- | ------------------------ |
| Request timeout, non-streaming   | 15 minutes               |
| Streaming (SSE) maximum duration | 60 minutes               |
| Maximum payload size             | 100 MB                   |
| Idle session timeout             | 15 minutes, configurable |
| Maximum session duration         | 8 hours                  |
| Hardware per session             | 2 vCPU / 8 GB            |
| Session storage                  | 1 GB                     |

A run that will take longer than 15 minutes has to be invoked as a stream, which buys 60. The server reports `HealthyBusy` on `/ping` while a run is in flight, which keeps
the session alive across a long turn instead of letting the idle timeout reclaim it.

There is no fire-and-forget mode. A payload is answered by the invocation that sent it,
so work that needs longer than the streaming window has to be split by the caller — or
this application needs a job store, which would mean giving it persistence it currently
does not have.

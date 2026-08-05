# Agent Harness

A headless TypeScript agent runtime for Node.js. One mode, one contract: post a
payload, get a run.

Everything a run needs travels on the request — the system prompt, the model and its
credential, the tools, the MCP servers, and the skills. The process opens no database,
reads no bucket, and holds no stored configuration, so any instance can serve any
request and a replica can be added or removed without draining.

```
POST /invocations   payload in, result or SSE event stream out
GET  /ping          health probe
```

That is the whole surface. There is no CLI agent, no session gateway, no desktop or
IDE adapter, and no `agents` collection: an earlier version of this repository had all
of them, and they are gone rather than deprecated.

## Requirements

- Node.js 22 or newer
- npm

No MongoDB. No AWS credentials. Nothing to seed before the first run.

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
  "permissionRules": [{ "tool": "read_file", "decision": "allow" }],
  "permissionFallback": "deny"
}
```

`agent`, `modelProvider`, and `prompt` are required; everything else has a default.
`mcpServers` and `skills` are inlined the same way — a stdio or HTTP server with its
credential, and a skill's whole `SKILL.md` including front matter. Omitting
`agent.tools` offers every tool the host built.

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

Add `Accept: text/event-stream` or `?stream=true` for SSE. Streaming is a transport
choice rather than a payload field, so a body cannot contradict the `Accept` its caller
sent.

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

The container needs no environment beyond what it ships with. Set
`AGENT_PERMISSION_CEILING` and `AGENT_SERVICE_KEY` for a deployment more than one
caller reaches.

Each invocation gets its own workspace directory named for the session, so concurrent
payloads cannot read each other's files. Directories are not deleted: a run's output is
often the files it wrote, and the path comes back on the result so the caller can
collect them. Sweep `AGENT_WORKSPACE`, or mount it on a volume with its own lifecycle.

## Migrating from stored agents

If you have agents in a MongoDB `agents` collection from a previous version,
`scripts/headless/exportPayload.ts` converts one into a payload file. It reads the four
old collections, downloads the skill documents its skills reference, and writes the lot
out self-contained:

```bash
npm run export-payload -- --agent sap-documentation-agent --out payload.json
npm run payload -- payload.json
```

It is the only thing left in the repository that opens a database, and it is
deliberately standalone so deleting it removes the last MongoDB dependency in one step.
The AWS variables are needed for the export and never again — the exported payload
carries the documents.

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

`invokeHeadless` returns the answer with what it cost: the concatenated assistant text,
the messages, per-tool call and error counts, the stop reason, token usage, and the
workspace path. A failure _inside_ the turn comes back as `status: 'error'` on a result
that still carries the partial output, because a run that spent tokens and then hit a
model error has produced something worth seeing. Only a payload the runner could not act
on throws.

`streamHeadless` yields `AgentEvent` verbatim — a versioned, serializable protocol, the
same one the SSE endpoint frames.

## Tools

`read_file`, `glob`, `grep`, `write_file`, `edit_file`, `bash`, `powershell`,
`todo_write`, `web_fetch`, `web_search`. A payload names the subset it wants.

Filesystem operations are confined to the workspace, edits require a prior read, and
shell commands are inspected before they run. `web_fetch` and `web_search` refuse
non-public hosts, URLs with embedded credentials, and non-http(s) schemes, and report
cross-site redirects to the model rather than following them.

Plan mode and `ask_user_question` are deliberately absent. Both need someone watching:
plan mode is a review step before a human approves, and a question suspends the turn
until one is answered. A payload is answered by nobody, so offering either would
produce a run that stalls or that silently picks an option on the caller's behalf. For
the same reason `permissionFallback` is `allow` or `deny` and never `ask`.

Skills arrive on the payload as documents and are written to a temporary directory in
the layout a local skill directory uses, so a payload skill is an ordinary skill file
rather than a special case. The directory is removed when the run ends, on the failure
path as much as the success one.

## Architecture

The invocation path is four files:

- [`payload.ts`](./src/headless/payload.ts) — the contract, as zod schemas
- [`inline-agent.ts`](./src/headless/inline-agent.ts) — payload to assembled agent
- [`invoke.ts`](./src/headless/invoke.ts) — the run, buffered or streamed
- [`server.ts`](./src/headless/server.ts) — the HTTP surface

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

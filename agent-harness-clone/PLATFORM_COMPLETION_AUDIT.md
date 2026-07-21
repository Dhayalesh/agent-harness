# Agent Platform Completion Audit

Audit date: 2026-07-20

## Result

The requested non-queue platform scope is implemented. The harness can run as
a frontend-independent service whose tenant-scoped agents, immutable versions,
deployments, skills, trusted tool bindings, data bindings, MCP selections,
permissions, limits, sessions, runs, events, audit history, and API-key hashes
are backed by MongoDB.

Queue-backed dispatch, worker leases, and horizontal API replicas are the only
deliberately deferred architecture phase. The current service executes runs in
one API process. It rehydrates open sessions after restart and marks runs
orphaned by the former process as failed on startup.

## Implemented evidence

| Area            | Result                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model providers | Anthropic, canonical OpenRouter, and operator-allowlisted OpenAI-compatible streaming providers; normalized text, tool calls, usage, stop, error, retry, and cancellation behavior |
| Control plane   | Tenant agents, immutable checksummed versions, publish, deployment revisions, rollback, archive guards, audit records, and role checks                                             |
| Database        | MongoDB stores and indexes for agents, versions, deployments, API keys, audit, model messages, platform sessions, run claims, and ordered replay events                            |
| Execution       | Stored definition resolves exact tool/MCP versions, skills, retrieved data, permissions, limits, model credential, workspace, artifacts, and session store                         |
| API             | Authenticated management endpoints, session creation/listing, SSE runs, asynchronous permission decisions, interrupt, replay, run status, and close                                |
| Isolation       | Tenant filters, hashed API/control tokens, tenant-secret namespaces, per-session workspaces/artifacts, safe Mongo filters, trusted model endpoints and exact MCP configurations    |
| Durability      | Idempotent run IDs, persisted events, automatic session rehydration, monotonic post-restart sequences, and orphaned-run recovery for the single-process mode                       |
| Demo            | MongoDB service entry point, setup script, and streaming run client; no frontend required                                                                                          |

## Verification performed

```bash
npm run check
npm run build
npm pack --dry-run --json
node -e "import('./dist/index.js')"
npm audit --omit=dev
```

Results:

- formatting and strict TypeScript checks passed;
- 69 deterministic tests passed;
- the credential-gated MongoDB integration test also passed separately against
  a real temporary MongoDB process (no mock database implementation);
- the compiled public API import and platform service package entries passed;
- the dry-run package contains the platform service, MongoDB stores, generated
  declarations, and model adapters;
- the production dependency audit reported zero vulnerabilities.

## Live provider gates not executed in this environment

The default suite reports three optional skips because it is intentionally not
given external configuration. The MongoDB test was then rerun with a temporary
MongoDB URI and passed. Two paid-provider calls remain unexecuted because no
provider credentials were supplied:

- live OpenRouter streaming: set `AGENT_HARNESS_LIVE_OPENROUTER=1` and
  `OPENROUTER_API_KEY=...`, then run `npm test`;
- live Anthropic streaming: set `AGENT_HARNESS_LIVE_ANTHROPIC=1` and
  `ANTHROPIC_API_KEY=...`, then run `npm test`.

These provider calls are deployment acceptance gates, not missing adapter code.
The deterministic suites exercise their request, SSE parsing, tool-fragment,
usage, completion, HTTP-error, and retry behavior without spending API credits.

## Deferred queue boundary

The future phase begins after the durable run claim. It should add queue
dispatch, worker ownership leases/heartbeats, retry/dead-letter policy, and
multi-replica coordination while retaining the current agent definition,
control-plane API, and event replay schema.

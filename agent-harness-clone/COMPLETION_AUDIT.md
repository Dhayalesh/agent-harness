# Migration Completion Audit

Audit date: 2026-07-19

## Result

The reusable harness implementation described by Phases 0–11 is complete in
this repository. It builds and runs independently of the reference
`claude-code` tree, and all included surfaces use the same `AgentSession` and
event protocol.

The remaining work is product rollout: wiring real terminal, web, desktop, and
IDE applications to these adapters, canarying them, and retiring their former
runtime paths. Those applications and deployment environments are outside this
repository, so the rollout is documented but not represented as completed here.

## Phase evidence

| Phase                           | Harness result             | Exit-gate evidence                                                                                                                                                      |
| ------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Baseline and decisions      | Complete                   | npm/TypeScript/Prettier/CI scaffold, `SOURCE_INVENTORY.md`, `CLEAN_ROOM.md`, ADRs, parity checklist                                                                     |
| 1 — Core contracts              | Complete                   | provider-neutral messages, protocol-v1 events, SDK example, cancellation/turn-limit/serialization tests                                                                 |
| 2 — Model and tool loop         | Complete                   | OpenRouter, scripted, and retry providers; valid/invalid tool and safe-concurrency tests; optional credential-gated live test                                           |
| 3 — Coding runtime              | Complete                   | six built-in tools, canonical workspace and symlink checks, read-before-edit snapshots, permission modes, shell process-tree cancellation                               |
| 4 — Consumer adapters           | Complete                   | CLI, SDK, JSONL, SSE, gateway permission routing, replay and cross-surface tests                                                                                        |
| 5 — Context and sessions        | Complete                   | project context, system prompt composition, usage/budgets, artifact previews, file persistence/restart, transcript export, pair-safe and reactive compaction            |
| 6 — Workflows and configuration | Complete                   | typed hooks, bounded stop continuation, deep layered config validation, commands, skills, CLI/server skill acceptance                                                   |
| 7 — MCP and plugins             | Complete                   | stdio/HTTP MCP client boundary, resources and elicitation, harness MCP server, trusted-root and explicit-capability plugin loader, contribution cleanup test            |
| 8 — Tasks and subagents         | Complete                   | background shell and agent tasks, parent correlation, output capture, cancellation, concurrency quota, team coordinator                                                 |
| 9 — Remote surfaces             | Complete                   | authenticated gateway, ownership/control tokens, idempotent run IDs, event replay, artifact transfer, desktop/IDE bridges, capability-limited runtime RPC               |
| 10 — Operations                 | Complete                   | optional event sinks, metrics/logs/notifications, secrets/provider auth, budgets, rate limits, diagnostics, update discovery, fault and performance tests, threat model |
| 11 — Validation                 | Complete for harness scope | normalized parity runner, migration compatibility guide, clean package/import/CLI checks, cross-surface coding trajectory, no reference-runtime imports                 |

## Automated verification

The completion audit ran these gates from a clean build:

```bash
npm run check
npm run build
npm pack --dry-run --json
node dist/adapters/cli/index.js "packaged smoke"
```

Result:

- formatting and TypeScript checks passed;
- 47 deterministic tests passed;
- 1 optional live OpenRouter test was skipped because it is credential-gated;
- the compiled CLI and compiled public SDK import both ran successfully;
- the package dry run contained only `dist`, `README.md`, and package metadata;
- `src` and package/build configuration contain no import or runtime reference
  to the old `claude-code` implementation.

To run the optional provider gate:

```bash
AGENT_HARNESS_LIVE_OPENROUTER=1 OPENROUTER_API_KEY=... npm test
```

## Scope boundary for cutover

The clone deliberately does not contain terminal rendering frameworks, React,
Electron UI, browser UI, or editor UI. A product is migrated when it:

1. creates or connects to an `AgentSession` through the public API;
2. renders protocol-v1 events without implementing a second tool loop;
3. routes permission and interrupt controls through the session/gateway;
4. passes its canary and rollback checks in `docs/migration-compatibility.md`;
5. removes its dependency on the old runtime.

This separation lets consumers move phase by phase without changing harness
behavior or granting browser/remote clients direct machine capabilities.

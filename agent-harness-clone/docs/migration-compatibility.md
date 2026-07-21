# Migration compatibility and cutover

## Supported migration

- Harness-owned v1 session JSON can be resumed by `FileSessionStore`.
- Agent event protocol v1 is replayable by sequence number.
- Provider, runtime, MCP, and plugin compatibility is enforced at adapter
  boundaries rather than by importing legacy modules.

Legacy Claude Code settings, OAuth state, internal analytics records, and React
UI state are intentionally not imported. A product that needs a specific legacy
format must provide a one-way converter into validated harness configuration or
session v1 data.

## Canary and parity

`runParityScenario()` executes a prompt against primary and candidate session
factories and compares normalized observable events. Product surfaces can use it
for shadow/canary validation without comparing volatile IDs or timestamps.

## Cutover

1. Pin the current working harness version.
2. Run contract, security, performance, and cross-surface acceptance suites.
3. Shadow representative requests and inspect parity differences.
4. Canary one consumer surface at a time.
5. Keep its prior package/container available as the rollback target.
6. Promote only after persisted-session restore and permission controls pass.

Rollback changes only the consuming surface's pinned harness build. Stored v1
sessions remain readable by the pinned previous version; schema changes require a
new version and a tested one-way migration before rollout.

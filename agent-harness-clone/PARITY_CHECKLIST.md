# Feature Parity Checklist

This checklist covers the UI-independent harness scope. Product UI migration and
deployment into separate consumer repositories are rollout work, not harness
runtime dependencies.

Status values: `complete`, `deferred`.

| Capability                                          | Status   | Primary evidence                                                                        |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| Repository/tooling baseline                         | complete | `package.json`, TypeScript configs, Prettier, CI workflow                               |
| Serializable messages and protocol-v1 events        | complete | `src/core/messages.ts`, `src/core/events.ts`, protocol tests                            |
| Session lifecycle, limits, cancellation             | complete | `src/core/agent-session.ts`, `tests/core/session.test.ts`                               |
| Provider-neutral model contract                     | complete | `src/models/provider.ts`                                                                |
| Deterministic scripted provider                     | complete | `src/models/scripted-provider.ts`                                                       |
| Production OpenRouter provider                      | complete | `src/models/openrouter-provider.ts`, malformed-stream, catalog, and optional live tests |
| Model/tool execution loop                           | complete | session tests for valid, invalid, serial, and safe-parallel calls                       |
| Tool registry and validation                        | complete | `src/tools/`, core trajectory tests                                                     |
| Local runtime and coding tools                      | complete | `src/runtime/`, `src/tools/builtin/`, runtime acceptance tests                          |
| Permissions and policy rules                        | complete | `src/permissions/`, direct and gateway permission tests                                 |
| CLI, SDK, JSONL, and SSE adapters                   | complete | `src/adapters/`, transport and acceptance tests                                         |
| Standalone agent-core API service                   | complete | `src/service/`, service integration test and demo client                                |
| Context and compaction                              | complete | `src/context/`, compaction and reactive-recovery tests                                  |
| Session persistence, resume, transcripts            | complete | `src/sessions/`, restart persistence tests                                              |
| Hooks and layered configuration                     | complete | `src/hooks/`, `src/config/`, hook/config tests                                          |
| Skills and commands                                 | complete | `src/skills/`, `src/commands/`, cross-surface skill test                                |
| MCP client/server                                   | complete | `src/mcp/`, real stdio fixture integration test                                         |
| Trusted plugin platform                             | complete | `src/plugins/`, capability and cleanup tests                                            |
| Background tasks, subagents, teams                  | complete | `src/tasks/`, quota/cancellation/correlation tests                                      |
| Gateway, desktop, IDE, remote runtime               | complete | gateway/adapters/runtime code and transport tests                                       |
| Artifacts and operational services                  | complete | `src/artifacts/`, `src/services/`, service tests                                        |
| Security and performance regression gates           | complete | security/performance tests and CI workflow                                              |
| Full cross-surface coding scenario                  | complete | `tests/acceptance/cross-surface.test.ts`                                                |
| Shadow parity comparison                            | complete | `src/testing/parity-runner.ts`, parity test                                             |
| Migration of product-specific UI code               | deferred | intentionally consumer-owned; excluded from harness core                                |
| Deployment/cutover of external production consumers | deferred | follow `docs/migration-compatibility.md` after integration                              |

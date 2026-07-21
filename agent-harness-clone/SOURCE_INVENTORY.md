# Reference subsystem inventory

| Reference subsystem            | Dependency pressure                       | Clone boundary                        | Status                               |
| ------------------------------ | ----------------------------------------- | ------------------------------------- | ------------------------------------ |
| Query engine/query loop        | Provider SDK, messages, compaction, tools | `core/`, `models/`                    | Implemented                          |
| Tool definitions/orchestration | UI, permissions, analytics                | `tools/`                              | Implemented independently            |
| Read/write/edit/search/shell   | Filesystem, process, sandbox              | `runtime/`, `tools/builtin/`          | Implemented                          |
| Permissions                    | React prompts, settings, policies         | `permissions/` + event protocol       | Implemented                          |
| Terminal UI/REPL               | React/Ink and UI state                    | `adapters/cli/` consumer              | Thin adapter implemented             |
| Structured SDK I/O             | Query engine and session state            | public API, `transports/`             | Implemented                          |
| Context and compaction         | Token services, API recovery              | `context/`                            | Implemented baseline                 |
| Sessions/transcripts           | History utilities and filesystem          | `sessions/`                           | Implemented                          |
| Commands                       | REPL and React local commands             | `commands/`, skills, surface commands | Implemented contract                 |
| Skills                         | Filesystem discovery and prompts          | `skills/`                             | Implemented                          |
| Plugins                        | Installation and product settings         | `plugins/`                            | Trusted loader implemented           |
| MCP                            | SDK, auth, UI elicitation                 | `mcp/`                                | Client/server/auth hooks implemented |
| Background tasks/subagents     | Process management and query engine       | `tasks/`                              | Implemented                          |
| Teams/coordinator              | Subagents and UI                          | `tasks/team-coordinator.ts`           | Implemented                          |
| Bridge/remote sessions         | WebSocket, auth, IDE product              | gateway, RPC, adapters                | Implemented protocol layer           |
| Web/desktop/IDE surfaces       | Product-specific rendering                | external consumers/adapters           | Harness adapters implemented         |
| Analytics/auth/diagnostics     | External services                         | optional `services/`                  | Implemented as ports/sinks           |
| React/Ink product components   | Terminal rendering                        | outside harness core                  | Intentionally consumer-owned         |

The inventory tracks behavioral destinations rather than source-file movement.
The old tree is never imported by the clone at build or runtime.

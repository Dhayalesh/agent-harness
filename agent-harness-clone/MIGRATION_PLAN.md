# Agent Harness Clone — Architecture and Phased Migration Plan

> Harness implementation status: complete. See
> [COMPLETION_AUDIT.md](./COMPLETION_AUDIT.md) for phase-by-phase evidence. The
> remaining activity is adoption and cutover in external product surfaces.

## 1. Purpose

`agent-harness-clone` will become a reusable agent runtime, not a terminal-only
application. The same harness must be callable from:

- a terminal CLI;
- a web application through a backend/runtime service;
- a desktop application;
- an IDE extension or bridge;
- an SDK embedded in another Node.js application;
- tests and automation without an interactive UI.

The existing `claude-code` project is a behavioral and architectural reference.
The clone should be implemented as a clean, independently structured codebase.
The reference repository describes itself as leaked and unlicensed, so source
files should not be copied verbatim.

## 2. Target outcome

The final system will provide one stable agent-session API that owns:

- model interaction and streaming;
- the model/tool execution loop;
- message and context management;
- tool discovery, validation, and execution;
- permission and policy decisions;
- cancellation, timeouts, retries, and limits;
- session persistence and resume;
- hooks, skills, plugins, and MCP integrations;
- background tasks and subagents;
- typed lifecycle events for any user interface.

Terminal, web, desktop, and IDE products will remain thin adapters. They may
render the agent differently, but they must not implement their own agent loop.

## 3. Architectural boundary

```text
 Terminal CLI       Web backend       Desktop app       IDE bridge       SDK
      |                   |                 |                |             |
      +-------------------+-----------------+----------------+-------------+
                                      |
                         Agent Session API + Event Stream
                                      |
       +------------------------------+------------------------------+
       |                  UI-independent harness core                |
       |                                                             |
       |  Session coordinator  ->  Agent loop  ->  Context manager   |
       |           |                   |                  |           |
       |           +-------- Tool orchestrator ----------+           |
       |                          |                                  |
       |                Permissions and policies                     |
       +--------------------------+----------------------------------+
                                  |
       +--------------------------+----------------------------------+
       | Provider, runtime, storage, plugin, and transport adapters  |
       +-------------------------------------------------------------+
```

The core must not import terminal, React, Electron, browser, or IDE UI code.
UI packages may depend on the core; the core must never depend on a UI package.

## 4. Core public contract

The initial API should converge on a shape similar to this:

```ts
const session = await createAgentSession({
  model,
  workingDirectory,
  tools,
  permissionHandler,
  sessionStore,
  limits,
});

for await (const event of session.run({ prompt })) {
  // Terminal prints it, web sends it over a socket, desktop renders it,
  // and an SDK consumer handles it programmatically.
}
```

The session control surface should support:

- `run(input)` — start or continue a turn and return an async event stream;
- `interrupt(reason)` — cancel current model/tool work;
- `respondToPermission(requestId, decision)` — resolve UI-mediated approval;
- `resume(sessionId)` — restore persisted session state;
- `close()` — release processes, connections, and other resources.

The event protocol should include at least:

- `session.started` and `session.completed`;
- `turn.started` and `turn.completed`;
- `assistant.text.delta` and `assistant.message.completed`;
- `tool.requested`, `tool.started`, `tool.progress`, and `tool.completed`;
- `permission.requested` and `permission.resolved`;
- `context.compaction.started` and `context.compaction.completed`;
- `usage.updated`;
- `warning` and `error`.

Events must be serializable. This lets the same protocol work in-process, over
WebSocket/SSE, over IPC, or through an IDE bridge.

## 5. Extension ports

The harness should depend on interfaces rather than individual products:

| Port                | Responsibility                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `ModelProvider`     | Stream model output and normalize tool calls, usage, and stop reasons |
| `Tool`              | Declare schema, metadata, safety properties, and execution behavior   |
| `ToolRegistry`      | Register, filter, discover, and resolve tools                         |
| `PermissionHandler` | Approve, deny, or request a user decision                             |
| `PolicyEngine`      | Enforce workspace, organization, sandbox, and tool rules              |
| `RuntimeHost`       | Provide filesystem, process, network, and sandbox capabilities        |
| `SessionStore`      | Persist messages, metadata, checkpoints, and resumable state          |
| `ArtifactStore`     | Store large tool output, patches, images, and generated files         |
| `SecretProvider`    | Supply API credentials without placing secrets in events or messages  |
| `EventSink`         | Optionally record or forward lifecycle events                         |
| `PluginLoader`      | Discover and load trusted extension packages                          |

This separation is required for web and remote use. A browser runtime must not
receive unrestricted filesystem or shell capabilities. It talks to a trusted
backend `RuntimeHost`, while a desktop application may provide a local host.

## 6. Repository direction

The repository can begin as one package while preserving boundaries that can be
split into a workspace later:

```text
agent-harness-clone/
├── src/
│   ├── core/                 # Agent loop, sessions, messages, events, limits
│   ├── models/               # Provider interface and provider adapters
│   ├── tools/                # Tool contract, registry, orchestration
│   ├── permissions/          # Permission requests, rules, and policies
│   ├── context/              # Project context, token budgeting, compaction
│   ├── sessions/             # Persistence, checkpoints, resume
│   ├── runtime/              # Local and remote runtime-host contracts
│   ├── hooks/                # Pre/post model and tool lifecycle hooks
│   ├── skills/               # Skill loading and invocation
│   ├── plugins/              # Plugin contracts and loader
│   ├── mcp/                  # MCP client/server integration
│   ├── tasks/                # Background tasks and subagents
│   ├── transports/           # In-process, JSONL, WebSocket/SSE, IPC
│   ├── adapters/
│   │   ├── cli/              # Thin terminal consumer
│   │   ├── server/           # Web/API consumer
│   │   ├── desktop/          # Desktop IPC adapter
│   │   └── ide/              # IDE bridge adapter
│   └── index.ts              # Supported public API
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── fixtures/
├── examples/
│   ├── cli/
│   ├── sdk/
│   └── server/
├── docs/
│   ├── architecture/
│   ├── protocols/
│   └── decisions/
├── package.json
├── tsconfig.json
└── README.md
```

If the adapters grow substantially, the repository should become a workspace
with packages such as `@agent-harness/core`, `@agent-harness/node-runtime`,
`@agent-harness/cli`, and `@agent-harness/server`.

## 7. Migration principles

1. **Vertical slices must run.** Each phase ends with an executable or testable
   capability, not only moved types or incomplete files.
2. **Core first, surfaces second.** Behavior belongs in the harness; UIs only
   translate input, events, and permission responses.
3. **Provider-neutral internal types.** Anthropic-specific SDK types stop at the
   provider boundary.
4. **Fail closed.** Unknown tools, invalid schemas, missing permissions, and
   unavailable runtime capabilities are denied or returned as controlled errors.
5. **Deterministic tests.** A scripted fake model is the primary test provider.
   Real API tests are optional and separately gated.
6. **No hidden global state.** Sessions receive dependencies through explicit
   configuration so multiple sessions can run safely in one process.
7. **Serializable state and events.** In-process behavior must also work across
   web, desktop IPC, and remote transports.
8. **Compatibility through adapters.** Existing behavior may be emulated at the
   boundary without carrying old UI or service coupling into the core.
9. **Observability without coupling.** Metrics and tracing consume events/hooks;
   they are not prerequisites for agent execution.

## 8. Phased delivery plan

### Phase 0 — Baseline, inventory, and decisions

**Goal:** Establish a safe migration map and prevent architecture drift.

Work:

- inventory the reference subsystems and their dependencies;
- classify each feature as core, adapter, optional extension, or product service;
- record architecture decisions for runtime, schemas, events, persistence, and
  package boundaries;
- scaffold TypeScript, formatting, type checking, and tests;
- add a feature-parity checklist to the repository;
- document clean-room implementation rules.

Exit gate:

- `npm install`, type checking, and an empty test suite run successfully;
- public boundaries and dependency-direction rules are documented;
- every reference subsystem has a destination or an explicit defer decision.

### Phase 1 — Core contracts and deterministic session skeleton

**Goal:** Run a UI-independent session with a fake model and no tools.

Work:

- message and content-block types;
- normalized completion and stop reasons;
- agent event protocol;
- `ModelProvider` interface;
- agent session lifecycle and cancellation;
- maximum turns, output limits, and terminal error states;
- scripted fake model for deterministic tests.

Exit gate:

- an SDK example streams a plain assistant response;
- cancellation and maximum-turn tests pass;
- event serialization round trips without loss.

### Phase 2 — Model execution and tool loop

**Goal:** Complete the central model -> tool -> result -> model loop.

Work:

- first production model adapter, initially Anthropic;
- streamed text and tool-call assembly;
- tool schema conversion at the provider boundary;
- tool registry and lookup;
- input validation;
- normalized tool results and tool errors;
- sequential execution by default;
- concurrency only for explicitly safe tools;
- retry classification and exponential backoff for transient model errors.

Exit gate:

- a fake provider completes single-tool and multi-tool trajectories;
- an optional API-key-gated test completes a real tool call;
- malformed and unknown tool calls cannot crash the session.

### Phase 3 — Local coding runtime and permissions

**Goal:** Make the harness useful for real repository work while enforcing a
clear security boundary.

Work:

- local `RuntimeHost` implementation;
- `read_file`, `glob`, `grep`, `write_file`, `edit_file`, and `bash` tools;
- canonical path and workspace-boundary checks;
- read-before-edit and modified-since-read protection;
- command timeout, output truncation, and process-tree cancellation;
- read-only versus mutating/destructive classifications;
- permission modes and allow/ask/deny rules;
- interactive permission requests and non-interactive fail-closed behavior;
- optional sandbox adapter boundary.

Exit gate:

- the agent can inspect a fixture repository, edit it, and run its tests;
- writes outside the workspace are rejected;
- interrupting a shell command terminates its process tree;
- permission behavior is covered by contract tests.

### Phase 4 — First consumer adapters

**Goal:** Prove that the same harness works from multiple surfaces.

Work:

- minimal terminal adapter using the session event stream;
- SDK entrypoint with stable exports;
- headless JSONL input/output adapter for automation;
- small HTTP plus WebSocket/SSE server example;
- permission-response routing over transports;
- protocol versioning and compatibility tests.

Exit gate:

- terminal and server examples run the same core scenario;
- neither consumer contains tool-loop or permission-policy logic;
- recorded events from one transport replay correctly through another.

### Phase 5 — Project context, sessions, and compaction

**Goal:** Support long-running and resumable conversations.

Work:

- project/environment context collection;
- system prompt composition from explicit sections;
- token and cost accounting;
- configurable context-window limits;
- large tool-result storage with bounded previews;
- message normalization before provider calls;
- session persistence and checkpoints;
- resume and transcript export;
- micro-compaction and full compaction behind interfaces;
- recovery for prompt-too-long and interrupted trajectories.

Exit gate:

- sessions survive process restart and resume without corrupting tool-call pairs;
- long fixture conversations compact and continue successfully;
- secrets and non-model UI events are excluded from provider messages.

### Phase 6 — Hooks, commands, skills, and configuration

**Goal:** Add reusable workflows without coupling them to a terminal UI.

Work:

- typed pre/post model and pre/post tool hooks;
- stop hooks and continuation decisions with loop protection;
- layered configuration: defaults, user, project, organization, and session;
- prompt commands as harness-level workflows;
- local commands as adapter capabilities where appropriate;
- skill manifest, loader, activation, and invocation;
- filesystem watching/reload as an optional adapter;
- tool and skill allowlists per session.

Exit gate:

- the same skill runs through CLI and server adapters;
- hooks can block or transform an operation without UI dependencies;
- invalid configuration produces actionable diagnostics.

### Phase 7 — MCP and plugin platform

**Goal:** Make external tools and extensions first-class but isolated.

Work:

- MCP client connections and normalized dynamic tools;
- MCP resources and prompts;
- authentication/elicitation routed through session events;
- MCP server mode for exposing selected harness capabilities;
- plugin manifest and compatibility version;
- trusted plugin discovery, load/unload, and contribution points;
- plugin-contributed tools, skills, hooks, and providers;
- isolation and explicit capability grants for third-party plugins.

Exit gate:

- one MCP server can contribute and execute a tool;
- one sample plugin can register a tool and skill;
- disabling a plugin cleanly removes all of its contributions.

### Phase 8 — Background tasks and subagents

**Goal:** Support concurrent work without weakening session consistency.

Work:

- task lifecycle and task registry;
- background shell tasks with persisted output;
- local subagent sessions with scoped tools and budgets;
- parent/child event correlation;
- task output, stop, resume, and cleanup;
- concurrency limits and resource quotas;
- isolated context and permission inheritance rules;
- optional multi-agent team/coordinator behavior after subagents are stable.

Exit gate:

- background tasks survive the originating turn and can be stopped;
- subagent results return to the parent with traceable IDs;
- cancellation and failure cannot orphan processes or corrupt parent state.

### Phase 9 — Web, desktop, IDE, and remote execution

**Goal:** Provide production-ready non-terminal surfaces on the same protocol.

Work:

- authenticated server session gateway;
- remote `RuntimeHost` protocol and capability negotiation;
- desktop IPC adapter and local runtime host;
- IDE bridge for selections, diagnostics, diffs, and permission prompts;
- attachment and artifact transfer;
- reconnect, event replay, idempotency, and backpressure;
- multi-client session ownership and control rules;
- transport security, secret separation, and audit events.

Exit gate:

- terminal, web, desktop, and IDE can operate the same saved session;
- reconnect does not duplicate tool execution;
- remote clients can only access explicitly granted runtime capabilities.

### Phase 10 — Product services and operational hardening

**Goal:** Add production services around the harness without making them core
execution dependencies.

Work:

- structured logging, metrics, tracing, and opt-out controls;
- rate limits, budget limits, and usage reporting;
- provider credential and authentication adapters;
- diagnostics/doctor checks;
- notification adapters;
- update and distribution strategy for each surface;
- performance profiling, load testing, and fault injection;
- security review and threat-model validation.

Exit gate:

- the harness still runs with telemetry and product services disabled;
- operational failures degrade predictably and do not lose session state;
- performance and security targets are measured in CI.

### Phase 11 — Parity validation and cutover

**Goal:** Finish migration based on measured behavior rather than file count.

Work:

- run the parity matrix against representative scenarios;
- provide compatibility adapters or migrations for stored configuration/session
  formats that are intentionally supported;
- shadow or canary the new harness in selected surfaces;
- compare tool results, permission decisions, context behavior, and failures;
- document intentionally removed or redesigned behavior;
- freeze the old implementation and move remaining consumers to the new API.

Exit gate:

- all required parity scenarios pass;
- every production surface uses the new session API;
- rollback and data-migration procedures have been exercised;
- the reference implementation is no longer a runtime dependency.

## 9. Reference subsystem migration map

| Reference area                              | Clone destination                           | Planned phase  |
| ------------------------------------------- | ------------------------------------------- | -------------- |
| Query engine and query loop                 | `core/`                                     | 1–2            |
| Tool types, registry, and execution         | `tools/`                                    | 2–3            |
| File/search/bash tools                      | `tools/builtin/` + `runtime/`               | 3              |
| Permission hooks and rules                  | `permissions/`                              | 3              |
| CLI/REPL                                    | `adapters/cli/`                             | 4              |
| Agent SDK and structured I/O                | public API + `transports/`                  | 4              |
| Context, token counting, compaction         | `context/`                                  | 5              |
| Session history and resume                  | `sessions/`                                 | 5              |
| Commands                                    | `skills/`, hooks, or surface-local commands | 6              |
| Skills                                      | `skills/`                                   | 6              |
| Configuration and schemas                   | `core/config` or `permissions/`             | 6              |
| MCP client/server                           | `mcp/`                                      | 7              |
| Plugins                                     | `plugins/`                                  | 7              |
| Background tasks                            | `tasks/`                                    | 8              |
| Agent/subagent/team tools                   | `tasks/agents/`                             | 8              |
| Web/desktop/IDE bridge                      | adapters + transports                       | 9              |
| Remote sessions                             | server gateway + remote runtime             | 9              |
| Analytics, auth, diagnostics, notifications | optional services/adapters                  | 10             |
| React/Ink UI components                     | separate terminal product, not harness core | Consumer-owned |

## 10. Testing strategy

Every phase must add tests at the lowest useful level:

- **Unit tests:** schemas, path checks, transitions, policies, message transforms.
- **Contract tests:** every provider, runtime, session store, and transport must
  satisfy a shared behavioral suite.
- **Integration tests:** scripted model trajectories using real tools in temporary
  fixture workspaces.
- **Protocol tests:** serialize, replay, reconnect, and version event streams.
- **Security tests:** traversal, symlinks, command cancellation, permission bypass,
  secret redaction, and malicious tool inputs.
- **Optional live tests:** provider APIs and external MCP servers, gated by
  credentials and excluded from deterministic CI.
- **End-to-end tests:** identical scenarios through CLI, server, desktop IPC, and
  IDE adapters once those surfaces exist.

No phase is complete if its main success path can only be verified manually.

## 11. Cross-phase acceptance scenario

The same scenario should be kept as a growing end-to-end fixture:

1. Start or resume an agent session in a fixture repository.
2. Ask the agent to find a failing test.
3. Observe streamed reasoning-safe text and tool lifecycle events.
4. Read and search relevant files.
5. Request permission for a mutation.
6. Edit the implementation.
7. Run the relevant test command.
8. Return a final answer containing the result.
9. Persist, close, resume, and inspect the transcript.
10. Run the scenario through every available consumer adapter.

This measures useful parity and protects the shared harness boundary as more
features are migrated.

## 12. Definition of complete migration

The migration is complete when:

- the core is independently buildable, testable, and usable as an SDK;
- terminal, web, desktop, and IDE surfaces call the same session API;
- model providers and runtime hosts are replaceable adapters;
- tools, permissions, persistence, compaction, hooks, skills, plugins, MCP,
  tasks, and subagents pass their documented contract tests;
- no UI framework is imported by the core;
- remote/browser clients cannot bypass runtime-host permissions;
- required behavior is represented in the parity matrix;
- intentionally excluded behavior is documented;
- the old codebase is no longer required to build or run the new system.

## 13. Post-implementation rollout milestone

The harness phases are implemented. Consumers can now migrate independently:

1. select one terminal, web, desktop, or IDE consumer as a canary;
2. replace its internal agent loop with the public session or gateway API;
3. map protocol-v1 events to that product's renderer;
4. route permission, interrupt, replay, and artifact controls through the
   harness;
5. compare behavior with the parity runner and product acceptance tests;
6. exercise rollback, then remove the consumer's old runtime dependency;
7. repeat for the remaining surfaces.

Consumer rollout details and compatibility boundaries are documented in
`docs/migration-compatibility.md`.

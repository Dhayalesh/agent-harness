# MongoDB Schema Audit

Read-only audit of the MongoDB layer prior to schema simplification. No code was
modified. No write, drop, or create operation was issued against any database.

Scope: `src/platform/*` is the only part of the codebase that touches MongoDB.
Entry point is `src/platform/service-index.ts` (`npm run platform`), database name
`process.env.MONGODB_DATABASE ?? 'trueai_agent_platform'`
(`src/platform/service-index.ts:9`).

Headline findings, before the detail:

1. The live database contains four collections that no code in this repository
   references, one of which stores a credential in plaintext.
2. Live documents contain three fields absent from the TypeScript types, and the
   stored agent definitions use `providerRef` where the code requires `secretRef`.
   Those deployed versions cannot execute against `src/` as written.
3. `agent_sessions.messages` is an unbounded array rewritten in full on every
   turn. Compaction never trims it. This is the only realistic path to the 16MB
   document limit.
4. There is no `tenants` collection. `tenantId` is an unvalidated string.

---

## Part 1 — Schema from code

### 1.1 Collection inventory

Nine collection names are hardcoded. All are literal strings; none are namespaced
or templated per tenant. Tenant separation is a `tenantId` **field**, not a
collection or database prefix.

| Collection          | Defined at                           | Written by                                                        | Read by                                          | Purpose                                                             |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `agents`            | `src/platform/mongodb-store.ts:29`   | `createAgent` :55, `archiveAgent` :81, `allocateAgentVersion` :89 | `getAgent` :59, `listAgents` :67                 | Agent identity per tenant, plus the monotonic `versionCounter`      |
| `agent_versions`    | `src/platform/mongodb-store.ts:30`   | `insertAgentVersion` :103                                         | `getAgentVersion` :107, `listAgentVersions` :119 | Immutable checksummed agent definitions                             |
| `agent_deployments` | `src/platform/mongodb-store.ts:31`   | `setDeployment` :124 (upsert)                                     | `getDeployment` :146, `listDeployments` :154     | Which version is live in which environment, with a revision counter |
| `platform_audit`    | `src/platform/mongodb-store.ts:32`   | `appendAudit` :159 (insert only)                                  | `listAudit` :163                                 | Control-plane audit trail                                           |
| `platform_api_keys` | `src/platform/mongodb-store.ts:33`   | `insertApiKey` :172, `touchApiKey` :185, `revokeApiKey` :189      | `listApiKeys` :176, `findApiKeyByHash` :181      | Hashed platform API keys and their roles                            |
| `agent_sessions`    | `src/platform/mongodb-runtime.ts:22` | `save` :33 (`replaceOne` upsert), `delete` :41                    | `load` :29, `list` :46                           | Model conversation history for session resume                       |
| `platform_sessions` | `src/platform/mongodb-runtime.ts:74` | `createSession` :104, `closeSession` :128                         | `getSession` :108, `listSessions` :115           | Session ownership, control-token hash, open/closed status           |
| `platform_runs`     | `src/platform/mongodb-runtime.ts:75` | `claimRun` :136, `finishRun` :154, `recoverOrphanedRuns` :90      | `getRun` :146                                    | Run claim records; backs idempotent run IDs                         |
| `platform_events`   | `src/platform/mongodb-runtime.ts:76` | `appendEvent` :175                                                | `listEvents` :179, `listRunEvents` :187          | Ordered protocol-v1 event log for replay                            |

**Dynamically named collection.** `MongoCollectionDataSourceConnector`
(`src/platform/catalogs.ts:204`) reads an arbitrary collection whose name comes
from the agent definition's data-source `config.collection`
(`src/platform/catalogs.ts:242`). The name is operator-supplied at agent-definition
time, validated against `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/` and rejected if it
starts with `system.` (`src/platform/catalogs.ts:215-219`). It is **read-only** and
runs against the same database as the platform collections
(`src/platform/mongodb-platform-service.ts:64`). No such collection is created by
this codebase; it is expected to pre-exist.

**No `tenants` collection.** NOT FOUND. There is no tenant registry in code or in
the live database. `tenantId` originates from either the bootstrap env var
(`src/platform/mongodb-platform-service.ts:150-157`) or an API key record, and is
never validated against a list.

### 1.2 Schema per collection

**Every collection has NO SCHEMA at the database level.** There are no
`createCollection` calls, no `$jsonSchema` validators, and no `collMod`. Documents
are constrained only by TypeScript at compile time and by the driver's generic
parameter, neither of which validates at runtime. The one runtime-validated
payload is the nested `definition` object in `agent_versions`, checked by Zod at
the API boundary (`parseAgentDefinition`, `src/platform/definitions.ts:203`).

Types are verbatim below. TypeScript optional (`?`) maps to an omitted field;
MongoDB stores nothing for it, so filters use `{ $exists: false }`.

#### `agents` — `src/platform/definitions.ts:149`

```ts
export type AgentRecord = {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  versionCounter: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  archivedAt?: string;
};
```

All required except `archivedAt` (optional; its absence _is_ the "active" flag,
`src/platform/mongodb-store.ts:70`).

#### `agent_versions` — `src/platform/definitions.ts:162`

```ts
export type AgentVersionRecord = {
  id: string;
  tenantId: string;
  agentId: string;
  version: number;
  definition: AgentDefinition;
  checksum: string;
  createdAt: string;
  createdBy: string;
};
```

All required. `definition` is the only runtime-validated subtree
(`src/platform/definitions.ts:84`), trimmed here to field names and types:

```ts
export const agentDefinitionSchema = z
  .object({
    systemPrompt: z.string().min(1).max(500_000),
    model: modelBindingSchema,
    tools: z.array(toolBindingSchema).max(200).default([]),
    skills: z.array(skillBindingSchema).max(100).default([]),
    dataSources: z.array(dataSourceBindingSchema).max(100).default([]),
    mcpServers: z.array(mcpServerBindingSchema).max(50).default([]),
    permissions: z
      .object({
        mode: z.enum(['default', 'plan', 'bypass', 'deny']).default('default'),
        fallback: z.enum(['allow', 'deny', 'ask']).default('ask'),
        rules: z.array(permissionRuleSchema).max(500).default([]),
      })
      .strict()
      .default({ mode: 'default', fallback: 'ask', rules: [] }),
    limits: z
      .object({
        maxTurns: z.number().int().positive().max(1_000).default(24),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        maxTotalTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .strict()
      .default({ maxTurns: 24 }),
    metadata: jsonObject.default({}),
  })
  .strict();
```

Nested bindings, verbatim (`src/platform/definitions.ts:12-70`):

```ts
export const modelBindingSchema = z
  .object({
    provider: z.enum(['openrouter', 'openai-compatible']).default('openrouter'),
    model: z.string().min(1).max(300),
    secretRef: identifier, // required
    baseURL: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const skillBindingSchema = z
  .object({
    name: identifier,
    version: z.string().min(1).max(100),
    description: z.string().max(1_000),
    instructions: z.string().min(1).max(200_000),
    allowedTools: z.array(identifier).optional(),
  })
  .strict();

export const dataSourceBindingSchema = z
  .object({
    name: identifier,
    type: identifier,
    version: z.string().min(1).max(100),
    config: jsonObject, // unbounded, arbitrary keys
    secretRefs: z.array(identifier).optional(),
  })
  .strict();
```

`.strict()` on every object means an unknown key is a validation **error**, not a
silently accepted extra. This matters for the drift in Part 2.

#### `agent_deployments` — `src/platform/definitions.ts:173`

```ts
export type DeploymentRecord = {
  id: string;
  tenantId: string;
  agentId: string;
  environment: string;
  versionId: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};
```

All required. `id` is set only via `$setOnInsert`, `revision` only via `$inc`
(`src/platform/mongodb-store.ts:131-133`).

#### `platform_audit` — `src/platform/definitions.ts:184`

```ts
export type AuditRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  details: Record<string, unknown>;
};
```

All required. `details` is an untyped open object; contents vary by `action`
(`src/platform/control-plane.ts:44, 76, 106, 127, 155, 220, 243`).

#### `platform_api_keys` — `src/platform/definitions.ts:195`

```ts
export type ApiKeyRecord = {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  roles: PlatformRole[]; // 'admin' | 'editor' | 'executor' | 'viewer'
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
  revokedAt?: string;
};
```

`lastUsedAt` and `revokedAt` optional. `revokedAt` absence is the "active" flag
(`src/platform/mongodb-store.ts:191`).

#### `agent_sessions` — `src/platform/mongodb-runtime.ts:13`

```ts
type TenantSessionDocument = StoredSession & { tenantId: string };
```

```ts
export type StoredSession = {
  // src/sessions/session-store.ts:3
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  metadata: Record<string, unknown>;
};
```

```ts
export type AgentMessage = {
  // src/core/messages.ts:29
  id: string;
  role: 'user' | 'assistant';
  content: MessageContent[];
  createdAt: string;
};

export type MessageContent = TextBlock | ToolCallBlock | ToolResultBlock;

export type ToolResultBlock = {
  // src/core/messages.ts:15
  type: 'tool_result';
  toolCallId: string;
  content: string; // unbounded string
  isError: boolean;
  metadata?: Record<string, unknown>;
};
```

All required. `metadata` is untyped at the store layer but is populated with a
fixed six-field shape by the platform (`src/platform/execution.ts:152-159`):
`tenantId`, `agentId`, `agentVersionId`, `agentVersion`, `deploymentEnvironment`,
`deploymentRevision`.

#### `platform_sessions` — `src/platform/runtime-state.ts:3`

```ts
export type PlatformSessionRecord = {
  sessionId: string;
  tenantId: string;
  ownerId: string;
  agentIdOrSlug: string;
  environment: string;
  controlTokenHash: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
};
```

All required.

#### `platform_runs` — `src/platform/runtime-state.ts:15`

```ts
export type PlatformRunRecord = {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  error?: string;
};
```

`error` optional.

#### `platform_events` — `src/platform/runtime-state.ts:26`

```ts
export type StoredPlatformEvent = {
  id: string;
  tenantId: string;
  sessionId: string;
  runId: string;
  sequence: number;
  event: AgentEvent;
  createdAt: string;
};
```

All required. `event` is a 17-arm discriminated union
(`src/core/events.ts:11-70`); the base and the size-relevant arms:

```ts
type EventBase = {
  protocolVersion: 1;
  sequence: number;
  timestamp: string;
  sessionId: string;
};

// arms carrying unbounded payloads:
| { type: 'assistant.text.delta'; turnId: string; delta: string }
| { type: 'assistant.message.completed'; turnId: string; message: AgentMessage }
| { type: 'tool.completed'; turnId: string; result: ToolResultBlock }
| { type: 'permission.requested'; turnId: string; requestId: string;
    toolCallId: string; toolName: string; input: unknown; description: string }
```

`event.sequence` and `event.sessionId` duplicate the outer `sequence` and
`sessionId` columns.

### 1.3 Indexes

Thirteen indexes are declared, plus the implicit `_id_` on each collection. **No
TTL index exists anywhere** in code or in the live database.

| Collection          | Index                                                  | Unique | TTL | Defined at                           |
| ------------------- | ------------------------------------------------------ | ------ | --- | ------------------------------------ |
| `agents`            | `{ tenantId: 1, slug: 1 }`                             | yes    | no  | `src/platform/mongodb-store.ts:44`   |
| `agents`            | `{ tenantId: 1, id: 1 }`                               | yes    | no  | `src/platform/mongodb-store.ts:45`   |
| `agent_versions`    | `{ tenantId: 1, agentId: 1, version: -1 }`             | yes    | no  | `src/platform/mongodb-store.ts:46`   |
| `agent_versions`    | `{ tenantId: 1, agentId: 1, id: 1 }`                   | yes    | no  | `src/platform/mongodb-store.ts:47`   |
| `agent_deployments` | `{ tenantId: 1, agentId: 1, environment: 1 }`          | yes    | no  | `src/platform/mongodb-store.ts:48`   |
| `platform_audit`    | `{ tenantId: 1, resourceId: 1, createdAt: -1 }`        | no     | no  | `src/platform/mongodb-store.ts:49`   |
| `platform_api_keys` | `{ keyHash: 1 }`                                       | yes    | no  | `src/platform/mongodb-store.ts:50`   |
| `platform_api_keys` | `{ tenantId: 1, id: 1 }`                               | yes    | no  | `src/platform/mongodb-store.ts:51`   |
| `agent_sessions`    | `{ tenantId: 1, id: 1 }`                               | yes    | no  | `src/platform/mongodb-runtime.ts:26` |
| `platform_sessions` | `{ tenantId: 1, sessionId: 1 }`                        | yes    | no  | `src/platform/mongodb-runtime.ts:81` |
| `platform_sessions` | `{ tenantId: 1, ownerId: 1, updatedAt: -1 }`           | no     | no  | `src/platform/mongodb-runtime.ts:82` |
| `platform_runs`     | `{ tenantId: 1, sessionId: 1, runId: 1 }`              | yes    | no  | `src/platform/mongodb-runtime.ts:83` |
| `platform_events`   | `{ tenantId: 1, sessionId: 1, sequence: 1 }`           | yes    | no  | `src/platform/mongodb-runtime.ts:84` |
| `platform_events`   | `{ tenantId: 1, sessionId: 1, runId: 1, sequence: 1 }` | no     | no  | `src/platform/mongodb-runtime.ts:85` |

`agent_sessions`'s index is created lazily per tenant store
(`src/platform/mongodb-runtime.ts:25-27`) and once at startup under the sentinel
tenant `'__index_initializer__'` (`src/platform/mongodb-runtime.ts:88`).

#### Query behind each index

| Index                                                    | Query that uses it                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents {tenantId, slug}`                                | `getAgent` `$or: [{id}, {slug}]` — `src/platform/mongodb-store.ts:60-63`                                                                               |
| `agents {tenantId, id}`                                  | `getAgent` (`$or` other branch) :60; `archiveAgent` :82; `allocateAgentVersion` :91; `listAgents` filter + `sort({id:1})` + cursor `{id:{$gt}}` :69-76 |
| `agent_versions {tenantId, agentId, version:-1}`         | `getAgentVersion` by number :108-111; `listAgentVersions` `sort({version:-1})` :120                                                                    |
| `agent_versions {tenantId, agentId, id}`                 | `getAgentVersion` by id :108-111, reached from `resolveDeployment` — `src/platform/control-plane.ts:190`                                               |
| `agent_deployments {tenantId, agentId, environment}`     | `setDeployment` upsert key :125-130; `getDeployment` :151                                                                                              |
| `platform_audit {tenantId, resourceId, createdAt:-1}`    | `listAudit` :164-167 — **partial match only**, see below                                                                                               |
| `platform_api_keys {keyHash}`                            | `findApiKeyByHash` :182 — the authentication hot path, `src/platform/control-plane.ts:232`                                                             |
| `platform_api_keys {tenantId, id}`                       | `touchApiKey` :186; `revokeApiKey` :190-193                                                                                                            |
| `agent_sessions {tenantId, id}`                          | `load` :30; `save` `replaceOne` filter :35; `delete` :42                                                                                               |
| `platform_sessions {tenantId, sessionId}`                | `getSession` :112 — called on every control and view authorization, `src/platform/session-manager.ts:242, 267`; `closeSession` :130                    |
| `platform_sessions {tenantId, ownerId, updatedAt:-1}`    | `listSessions` :117-119 — **partial match only**, see below                                                                                            |
| `platform_runs {tenantId, sessionId, runId}`             | `claimRun` duplicate-key detection :137-142; `getRun` :151; `finishRun` :156                                                                           |
| `platform_events {tenantId, sessionId, sequence}`        | `listEvents` :181; uniqueness enforces the monotonic sequence guarantee at `appendEvent` :176                                                          |
| `platform_events {tenantId, sessionId, runId, sequence}` | `listRunEvents` :189                                                                                                                                   |

**Indexes no query fully matches — simplification candidates:**

- `platform_audit {tenantId, resourceId, createdAt:-1}`. `resourceId` is optional
  in `listAudit` (`src/platform/mongodb-store.ts:163`) and the only API caller,
  `GET /v1/audit`, defaults it to `undefined`
  (`src/platform/api-server.ts:57-61`). With `resourceId` absent the query filters
  on `tenantId` alone and sorts on `createdAt`, so the middle key blocks the sort
  and Mongo sorts in memory. The correct index for the dominant query is
  `{tenantId: 1, createdAt: -1}`.
- `platform_sessions {tenantId, ownerId, updatedAt:-1}`. `listSessions` passes
  `ownerId: undefined` for admins (`src/platform/session-manager.ts:174-178`),
  producing the same prefix-then-blocked-sort shape.
- `platform_api_keys {tenantId, id}` supports point writes but not
  `listApiKeys`, which sorts by `createdAt` (`src/platform/mongodb-store.ts:177`)
  with no supporting index.
- `agent_sessions {tenantId, id}` does not support `list()`, which sorts by
  `updatedAt` (`src/platform/mongodb-runtime.ts:47-49`). `list()` also has no
  `limit`, so it returns every session document for a tenant, each carrying its
  full message history.

**Query with no index at all:** `recoverOrphanedRuns`
(`src/platform/mongodb-runtime.ts:90-102`) issues `updateMany({ status: 'running' })`.
There is no index on `status`, so this is a collection scan of `platform_runs` on
every process start.

### 1.4 Relationships

All references are application-level string fields. There are no DBRefs, no
foreign-key enforcement, no cascading deletes, and no multi-document
transactions anywhere in the codebase.

| From                | Field                | To                                   | Enforced by                                                                                |
| ------------------- | -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `agent_versions`    | `agentId`            | `agents.id`                          | `requireAgent` before insert, `src/platform/control-plane.ts:53`                           |
| `agent_deployments` | `agentId`            | `agents.id`                          | `requireAgent`, `src/platform/control-plane.ts:120`                                        |
| `agent_deployments` | `versionId`          | `agent_versions.id`                  | `requireVersion`, `src/platform/control-plane.ts:122`                                      |
| `platform_runs`     | `sessionId`          | `platform_sessions.sessionId`        | `authorizeControl` before claim, `src/platform/session-manager.ts:92`                      |
| `platform_events`   | `sessionId`, `runId` | `platform_sessions`, `platform_runs` | write path only                                                                            |
| `agent_sessions`    | `id`                 | `platform_sessions.sessionId`        | same generated id, `src/platform/session-manager.ts:64` — nothing links them in the schema |
| `platform_sessions` | `agentIdOrSlug`      | `agents.id` **or** `agents.slug`     | not validated on read; resolved at resume, `src/platform/session-manager.ts:250-255`       |

**Same data stored twice:**

| Duplicate                     | Locations                                                                                                                                                                   | Kept consistent by                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version counter               | `agents.versionCounter` vs `max(agent_versions.version)`                                                                                                                    | `findOneAndUpdate` `$inc` then a separate `insertOne` (`src/platform/mongodb-store.ts:89-102`, `src/platform/control-plane.ts:62-81`). Not atomic across the two collections: if the insert fails after the increment, the counter is permanently ahead and a version number is skipped. Not corrupting, but the two are not guaranteed equal. |
| Session id                    | `platform_sessions.sessionId` and `agent_sessions.id`                                                                                                                       | Nothing. `closeSession` sets `status: 'closed'` and never touches `agent_sessions`; `agent_sessions` documents are never deleted by the platform.                                                                                                                                                                                              |
| Event sequence and session id | outer `platform_events.sequence` / `.sessionId` vs `platform_events.event.sequence` / `.event.sessionId`                                                                    | The single write site copies both (`src/platform/session-manager.ts:124-131`). Nothing verifies them afterwards; the unique index constrains only the outer copy.                                                                                                                                                                              |
| Deployment provenance         | `agent_sessions.metadata.{tenantId, agentId, agentVersionId, agentVersion, deploymentEnvironment, deploymentRevision}` vs `agents` / `agent_versions` / `agent_deployments` | Snapshot written at session open (`src/platform/execution.ts:152-159`). Deliberately frozen and never reconciled — a rollback does not rewrite it.                                                                                                                                                                                             |
| Message content               | `agent_sessions.messages` vs `platform_events` arms `assistant.message.completed` and `tool.completed`                                                                      | Nothing. Two independent write paths carry the same assistant text and tool results (`src/core/agent-session.ts:327` and `src/platform/session-manager.ts:124`).                                                                                                                                                                               |

### 1.5 Growth and document-size risk

| Field                                                       | Grows with                                                                     | Cap                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `agent_sessions.messages`                                   | every user prompt, assistant message, stop-continuation, and tool-result batch | **none**                             |
| `agent_sessions.messages[].content[].content` (tool result) | tool output size                                                               | ~100_000 chars, see below            |
| `agent_versions.definition.skills[].instructions`           | agent authoring                                                                | 200_000 chars × 100 skills           |
| `agent_versions.definition.systemPrompt`                    | agent authoring                                                                | 500_000 chars                        |
| `agent_versions.definition.dataSources[].config`            | agent authoring                                                                | **none** (`jsonObject`)              |
| `platform_audit.details`                                    | per action                                                                     | **none** (`Record<string, unknown>`) |
| `platform_events` (document count)                          | every event of every run of every session, forever                             | **none**, no TTL, no pruning         |

**`agent_sessions.messages` can realistically reach 16MB.** The mechanism:

- `persist()` writes `structuredClone(this.history)` — the entire array — on every
  turn boundary: after the user message (`src/core/agent-session.ts:180`), after
  each assistant message (:327), after a stop-hook continuation (:345), and after
  each tool-result batch (:405). Implementation at
  `src/core/agent-session.ts:637-648`.
- The store performs a whole-document `replaceOne`
  (`src/platform/mongodb-runtime.ts:33-40`), so cost is O(history) per turn and
  O(n²) per session in bytes written.
- Compaction does **not** help. `contextManager.prepare` returns a reduced
  `prepared.messages` used only for the model request
  (`src/core/agent-session.ts:194-215`, consumed at :225). `this.history` is
  never trimmed, so the persisted document keeps every message the compactor
  removed from the prompt.
- Per-message size is bounded. Tool results larger than
  `maxInlineToolResultChars` (default `100_000`,
  `src/core/agent-session.ts:137`) are offloaded to the artifact store and
  replaced by a head/tail preview (`src/core/agent-session.ts:543-556`), and the
  Mongo platform always supplies a `FileArtifactStore`
  (`src/platform/mongodb-platform-service.ts:105-113`), so the cap is active.
- Net effect: roughly 160 large tool results, or a few thousand ordinary
  messages, exceed 16MB. `maxTurns` defaults to 24 per **run**
  (`src/platform/definitions.ts:100`) but a session accepts unlimited runs, so
  nothing bounds a long coding session. Once the document exceeds 16MB, `save()`
  fails and every subsequent turn of that session fails to persist.

**`agent_versions` can exceed 16MB from validation limits alone.** The Zod
schema admits 100 skills × 200_000 chars of `instructions`
(`src/platform/definitions.ts:34-41`, :88) plus a 500_000-char `systemPrompt`,
which is ~20MB — a definition that passes validation but cannot be inserted. In
practice the observed max is 1,547 bytes.

**`platform_events` grows in count, not per-document.** Individual events are
bounded by the same ~100_000-char tool-result cap, and `assistant.text.delta`
carries only a delta. The risks are elsewhere: `listEvents` loads **every** event
for a session into memory at the start of every run
(`src/platform/session-manager.ts:110`) purely to compute the last sequence
number, and `GET /v1/sessions/{id}/events` returns the whole unbounded array
(`src/platform/api-server.ts:207-217`). Both are unbounded reads with no
pagination beyond the `afterSequence` cursor.

### 1.6 Security-critical fields

**Tenant scoping — `tenantId`.** Present on every collection. Nothing structural
guarantees it is filtered: there is no query wrapper, no session-level
`$tenantId` binding, and no middleware. The guarantee is the convention that every
`PlatformStore` and `PlatformRuntimeStore` method takes `tenantId` as its first
parameter (`src/platform/store.ts:18-46`, `src/platform/runtime-state.ts:36-60`)
and that `tenantId` always comes from the authenticated principal, never from
request input (`src/platform/control-plane.ts` passes `principal.tenantId`
throughout). Two deliberate exceptions:

- `findApiKeyByHash(keyHash)` (`src/platform/mongodb-store.ts:181`) has no tenant
  filter — unavoidable, since the tenant is unknown until the key resolves.
- `recoverOrphanedRuns` (`src/platform/mongodb-runtime.ts:90-102`) issues a
  cross-tenant `updateMany({ status: 'running' })`. This is the only write in the
  codebase that spans tenants.

The tenant-scoped data-source connector re-applies the filter explicitly:
`[tenantField]: context.principal.tenantId` (`src/platform/catalogs.ts:234`),
with operator-supplied filters rejected if they contain `$` or `.` keys
(`assertSafeMongoFilter`, `src/platform/catalogs.ts:230, 316-328`).

**API key hashes — `platform_api_keys.keyHash`.** Secret is
`ahp_` + 32 random bytes base64url (`src/platform/control-plane.ts:212`). Stored
value is `sha256(secret)` hex, 64 chars (`hashApiKey`,
`src/platform/control-plane.ts:299-301`). Verified by hashing the presented
secret and doing an indexed equality lookup
(`src/platform/control-plane.ts:231-236`); revoked keys are rejected by the
`revokedAt` check at :233. Plaintext is returned once at creation and never
stored (:227-228). The bootstrap key is never persisted — it is compared against
the env var with `timingSafeEqual`
(`src/platform/mongodb-platform-service.ts:150-157, 162-166`). Unsalted SHA-256 is
acceptable here only because the secret is 256 bits of entropy, not a password.

**Control token hashes — `platform_sessions.controlTokenHash`.** 32 random bytes
base64url, stored as `sha256` hex (`src/platform/session-manager.ts:58-59,
276-278`). Verified in `authorizeControl` with a plain `!==` string comparison
(`src/platform/session-manager.ts:246`) — not constant-time, unlike the bootstrap
key path. Ownership is checked separately at :243.

**Credentials.** Per code, **no collection stores a credential**. `secretRef`,
`secretRefs`, and `providerRef`-style fields are _names_; values resolve from
environment variables namespaced per tenant
(`EnvironmentPlatformSecretResolver`, `src/platform/catalogs.ts:266-278`), and
model base URLs are rejected if they embed credentials
(`src/platform/model-resolver.ts:69-71`). MCP headers only interpolate declared
secret refs (`src/platform/execution.ts:311-330`). See Part 2 — the live database
contradicts this.

**Audit records — `platform_audit`.** Append-only _by construction_: the
`PlatformStore` interface exposes only `appendAudit` and `listAudit`
(`src/platform/store.ts:39-40`) and the Mongo implementation only ever calls
`insertOne` (`src/platform/mongodb-store.ts:159-161`). No update or delete path
exists in application code. Three gaps:

- Nothing prevents modification at the database level. There is no hash chain,
  no `prev` pointer, no signature, so tampering is undetectable.
- Coverage is control-plane only — `agent.created`, `agent.version.created`,
  `agent.archived`, `agent.deployed`, `agent.deployment.rolled_back`,
  `api_key.created`, `api_key.revoked` (`src/platform/control-plane.ts:44, 76,
106, 127, 155, 220, 243`). Session creation, run execution, permission
  decisions, and interrupts write **no** audit record.
- No retention policy and no TTL, so the collection grows without bound.

---

## Part 2 — Live database snapshot

**Database used:** `trueai_agent_platform` on `mongodb://127.0.0.1:27017`. This is
the local development instance from `docker-compose.yml`, which states it has no
authentication and is for local development only (`docker-compose.yml:2-3`). No
production database was contacted. `.env` was not read for values.

Operations issued, all read-only: `listDatabases`, `listCollections`,
`countDocuments`, `collStats`, `indexes`, `findOne`, `$indexStats`, and a
`$bsonSize` projection. No write, create, or drop.

| Collection                   | Docs | Size     | Avg doc | Largest doc | Indexes | In code? |
| ---------------------------- | ---- | -------- | ------- | ----------- | ------- | -------- |
| `agents`                     | 2    | 701 B    | 350 B   | 383 B       | 3       | yes      |
| `agent_versions`             | 2    | 2,193 B  | 1,096 B | 1,547 B     | 3       | yes      |
| `agent_deployments`          | 2    | 608 B    | 304 B   | 304 B       | 2       | yes      |
| `agent_sessions`             | 2    | 2,243 B  | 1,121 B | 1,165 B     | 2       | yes      |
| `platform_sessions`          | 2    | 744 B    | 372 B   | 372 B       | 3       | yes      |
| `platform_runs`              | 2    | 702 B    | 351 B   | 351 B       | 2       | yes      |
| `platform_events`            | 57   | 27,662 B | 485 B   | 733 B       | 3       | yes      |
| `platform_audit`             | 11   | 3,992 B  | 362 B   | 427 B       | 2       | yes      |
| `platform_api_keys`          | 0    | 0 B      | —       | —           | 3       | yes      |
| `platform_secrets`           | 1    | 361 B    | 361 B   | 361 B       | 3       | **no**   |
| `platform_model_providers`   | 1    | 407 B    | 407 B   | 407 B       | 3       | **no**   |
| `platform_trusted_base_urls` | 1    | 250 B    | 250 B   | 250 B       | 3       | **no**   |
| `platform_prompts`           | 0    | 0 B      | —       | —           | 3       | **no**   |

Index counts include `_id_`. All thirteen code-declared indexes exist with the
declared keys and uniqueness. No TTL index exists on any collection.

**`$indexStats` reported `accesses.ops: 0` for every index on every collection.**
These counters reset when the server restarts or a collection is reopened, so
this is not evidence that the indexes are unused. Treat it as no signal.

### Mismatch 1 — collections in the database that no code references

`platform_secrets`, `platform_model_providers`, `platform_trusted_base_urls`, and
`platform_prompts`. A repository-wide search for these names across `src`,
`tests`, `examples`, `docs`, `dist`, and all Markdown returned zero matches. All
four carry purpose-built unique indexes, so they were created by an
`initialize()`-style routine, not ad hoc.

Observed shapes, **field names and types only**:

```json
{
  "platform_secrets": {
    "_id": "<ObjectId>",
    "id": "<string, 36 chars>",
    "tenantId": "<string>",
    "reference": "<string>",
    "value": "<string, 70 chars>",
    "createdAt": "<string, ISO-8601>",
    "createdBy": "<string>",
    "updatedAt": "<string, ISO-8601>",
    "description": "<string>"
  },
  "platform_model_providers": {
    "_id": "<ObjectId>",
    "id": "<string, 36 chars>",
    "tenantId": "<string>",
    "name": "<string>",
    "provider": "<string>",
    "model": "<string>",
    "baseURL": "<string>",
    "secretRef": "<string>",
    "transport": "<string>",
    "enabled": "<boolean>",
    "createdAt": "<string, ISO-8601>",
    "createdBy": "<string>",
    "updatedAt": "<string, ISO-8601>"
  },
  "platform_trusted_base_urls": {
    "_id": "<ObjectId>",
    "id": "<string, 36 chars>",
    "tenantId": "<string>",
    "url": "<string>",
    "createdAt": "<string, ISO-8601>",
    "createdBy": "<string>",
    "description": "<string>"
  }
}
```

`platform_prompts` is empty; its shape cannot be reconstructed. Its indexes are
`{tenantId: 1, id: 1}` unique and `{tenantId: 1, name: 1, version: -1}` unique,
implying a named, versioned prompt record.

**`platform_secrets.value` holds a 70-character plaintext string alongside a
`reference` matching the `secretRef` naming convention.** No field name suggests
encryption, no `keyId`, `iv`, `algorithm`, or `ciphertext` field is present, and
the length is consistent with an unencrypted provider API key. The value was not
read into this report. This is a credential at rest in cleartext, and it
contradicts the code's design, where secrets resolve from environment variables
only (`src/platform/catalogs.ts:266-278`).

`platform_trusted_base_urls` mirrors the `PLATFORM_ALLOWED_MODEL_BASE_URLS` env
var (`src/platform/mongodb-platform-service.ts:74-81`), and
`platform_model_providers` mirrors `modelBindingSchema`. Both look like a
migration of operator configuration from environment variables into the database.

### Mismatch 2 — collections in code that do not exist in the database

None. All nine exist. `platform_api_keys` exists with 0 documents because
`initialize()` creates its indexes eagerly
(`src/platform/mongodb-store.ts:43-53`) and the deployment authenticates with the
bootstrap env key instead of an issued key.

### Mismatch 3 — fields in documents that are absent from the schema

| Collection       | Field present in data                                                                                | Schema says                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `agent_versions` | `definition.model.providerRef` (string, 12 chars)                                                    | not a member of `modelBindingSchema`, which is `.strict()` and requires `secretRef` (`src/platform/definitions.ts:14-21`) |
| `agent_versions` | `definition.model.secretRef` **missing**                                                             | required (`src/platform/definitions.ts:17`)                                                                               |
| `platform_runs`  | `resolvedProfileId` (string, 36 chars)                                                               | not in `PlatformRunRecord` (`src/platform/runtime-state.ts:15-25`)                                                        |
| `agent_sessions` | `metadata.modelBinding.{provider, model, profileName, profileId, baseUrlOrigin, indirectDefinition}` | `src/platform/execution.ts:152-159` writes six deployment fields and no `modelBinding`                                    |

`providerRef` / `profileId` / `resolvedProfileId` all point at
`platform_model_providers`, and `platform_secrets` supplies what `secretRef`
would have named. Taken together, the live database was written by a build that
had moved model credentials and model profiles into MongoDB.

That build is not in this repository, and never was.
`git log --all -S providerRef` and `git log --all -S platform_model_providers`
both return no commits, and `HEAD:src/platform/definitions.ts` uses `secretRef`
like the working tree. So the divergence is not an uncommitted local change or a
reverted commit — the writer is an external deployment sharing this local
MongoDB instance.

Consequence for the current code: `DefaultPlatformModelResolver` reads
`binding.secretRef` (`src/platform/model-resolver.ts:23-24`) and throws
`Missing model credential: undefined` when it is absent. Both stored
`agent_versions` documents lack it, so **every deployed agent version in this
database fails to start a run against `src/` as written**. Note that the
definition is not re-validated on read — `resolveDeployment` returns
`version.definition` without calling `parseAgentDefinition`
(`src/platform/control-plane.ts:176-195`) — so the failure surfaces at model
resolution, not as a validation error.

---

## Part 3 — Drop-impact analysis

| Collection                                | Breaks immediately                                                                                                                                                          | Breaks later                                                                                                                                                                                                                                                                                                       | Recoverable?                                                                  | Safe to drop                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `agents`                                  | Every control-plane read and write; `requireAgent` throws `Unknown agent` (`src/platform/control-plane.ts:255`), so no run can start                                        | `agent_versions` and `agent_deployments` become unreachable orphans                                                                                                                                                                                                                                                | No. `slug`, `name`, `createdBy`, `versionCounter` exist nowhere else          | **No**                                             |
| `agent_versions`                          | `resolveDeployment` throws `Unknown agent version` (`src/platform/control-plane.ts:194`); all execution stops                                                               | Rollback loses every target; the definition checksum injected into the system prompt is gone (`src/platform/execution.ts:171`)                                                                                                                                                                                     | No. Definitions are stored only here                                          | **No**                                             |
| `agent_deployments`                       | `resolveDeployment` throws `Agent is not deployed to {env}` (`src/platform/control-plane.ts:191`); all execution stops                                                      | `rollback` throws `No deployment exists` (`src/platform/control-plane.ts:150`)                                                                                                                                                                                                                                     | Partly — re-publish restores pointers; `revision` history is lost             | **No**, but rebuildable from `agent_versions`      |
| `platform_audit`                          | Nothing. `GET /v1/audit` returns `[]`                                                                                                                                       | Nothing functional                                                                                                                                                                                                                                                                                                 | No. Append-only history, no second copy                                       | Functionally yes — see compliance callout          |
| `platform_api_keys`                       | Every issued key fails auth: `findApiKeyByHash` returns undefined → `Invalid platform API key` (`src/platform/mongodb-platform-service.ts:158-160`)                         | Nothing further                                                                                                                                                                                                                                                                                                    | Only by re-issuing. Secrets are unrecoverable (hashes only)                   | **No** — see authentication callout                |
| `agent_sessions`                          | Nothing. `create` and in-process runs are unaffected because the live session is held in memory (`src/platform/session-manager.ts:71-76`)                                   | On the first control call after a restart, `authorizeControl` rehydrates via `resumeSession` → `resumeAgentSession` throws `Session not found` / `SESSION_NOT_FOUND` (`src/core/agent-session.ts:81-85`). Every pre-existing open session becomes permanently uncontrollable, and all conversation history is gone | No                                                                            | **No** — backs session rehydration                 |
| `platform_sessions`                       | `authorizeControl` and `authorizeView` throw `Unknown open session` for every existing session (`src/platform/session-manager.ts:242-248`); `GET /v1/sessions` returns `[]` | Nothing further; new sessions work                                                                                                                                                                                                                                                                                 | No. Control-token hashes and ownership exist nowhere else                     | **No** — backs control-token auth                  |
| `platform_runs`                           | Nothing. `claimRun` simply inserts (`src/platform/mongodb-runtime.ts:136-144`)                                                                                              | Idempotent run IDs stop working — a retried `runId` re-executes instead of replaying. `GET /v1/sessions/{id}/runs/{runId}` throws (`src/platform/api-server.ts:194`). Startup orphan recovery has nothing to mark failed                                                                                           | Terminal status is inferrable from the last event of a run, not automatically | **No** — backs run idempotency and orphan recovery |
| `platform_events`                         | Nothing for a brand-new run                                                                                                                                                 | Replay returns `[]` (`src/platform/api-server.ts:207`); completed-run replay-on-duplicate silently yields nothing (`src/platform/session-manager.ts:105-112`); the post-restart sequence baseline resets to 0 (`src/platform/session-manager.ts:110-112`)                                                          | No. This is the only durable record of what a run did                         | **No** — backs event replay                        |
| dynamically named data-source collections | Nothing throws; a missing collection returns `[]`                                                                                                                           | Agents bound to that data source silently lose their grounding documents (`src/platform/catalogs.ts:240-245`) — degraded answers, no error                                                                                                                                                                         | Depends on the external owner of the data                                     | Operator's call, but failure is silent             |
| `platform_secrets` (live only)            | Nothing in `src/`                                                                                                                                                           | Whatever build wrote it loses model credentials                                                                                                                                                                                                                                                                    | No — plaintext values cannot be regenerated                                   | **No** — investigate ownership first               |
| `platform_model_providers` (live only)    | Nothing in `src/`                                                                                                                                                           | The build behind `providerRef` / `resolvedProfileId` loses model resolution entirely                                                                                                                                                                                                                               | No                                                                            | **No** — investigate ownership first               |
| `platform_trusted_base_urls` (live only)  | Nothing in `src/`                                                                                                                                                           | Base-URL allowlisting for that build; `src/` uses the env var instead                                                                                                                                                                                                                                              | Yes, re-derivable from config                                                 | Likely, after confirming ownership                 |
| `platform_prompts` (live only)            | Nothing; empty                                                                                                                                                              | Unknown                                                                                                                                                                                                                                                                                                            | N/A (empty)                                                                   | Yes                                                |

**The four unreferenced collections are not dead weight.** They are referenced by
the same divergent build that wrote `providerRef`, `resolvedProfileId`, and
`metadata.modelBinding`. Dropping them because `src/` does not mention them would
break that build. Establish which deployment owns this database first.

### Collections holding authentication material

- **`platform_api_keys`** — dropping it locks out every client holding an issued
  key, permanently, because only `sha256` hashes are stored
  (`src/platform/control-plane.ts:217`). Recovery is possible **only** because the
  bootstrap key lives in the environment and is checked before the database
  (`src/platform/mongodb-platform-service.ts:150-157`); an admin can then
  re-issue keys. The live collection is empty, so today the practical blast
  radius is zero — but that is a property of this dev database, not of the design.
- **`platform_sessions`** — holds `controlTokenHash`. Dropping it revokes control
  of every in-flight session, since the token cannot be re-derived
  (`src/platform/session-manager.ts:246`).
- **`platform_secrets`** (live only) — holds a plaintext credential. Do not drop
  before confirming no deployment reads it, and treat the value as compromised
  regardless, given it sits unencrypted in an unauthenticated local instance.

### Collections holding audit or compliance records

`platform_audit` is the only one. Nothing in the running system reads it except
the admin `GET /v1/audit` endpoint, so dropping it breaks no feature. It records
agent creation, versioning, archiving, deployment, rollback, and API-key
creation and revocation — the deployment provenance trail. If the platform is
subject to a retention obligation, this is the collection that satisfies it, and
it cannot be reconstructed. Note that it does **not** currently deliver
tamper-evidence: there is no hash chain and no database-level write restriction,
so it would not survive scrutiny as an immutable log without additional
controls.

### Collections backing durability guarantees in `PLATFORM_COMPLETION_AUDIT.md`

`PLATFORM_COMPLETION_AUDIT.md:28` claims: "Idempotent run IDs, persisted events,
automatic session rehydration, monotonic post-restart sequences, and
orphaned-run recovery for the single-process mode."

| Guarantee                        | Backed by                              | Mechanism                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotent run IDs               | `platform_runs`                        | Unique index `{tenantId, sessionId, runId}` (`src/platform/mongodb-runtime.ts:83`); `claimRun` treats duplicate-key error 11000 as "already claimed" (:137-142); the caller then replays stored events for a completed or cancelled run (`src/platform/session-manager.ts:104-112`) |
| Persisted events / replay        | `platform_events`                      | `appendEvent` per event (`src/platform/session-manager.ts:124-131`); `listEvents` / `listRunEvents` (`src/platform/mongodb-runtime.ts:179, 187`)                                                                                                                                    |
| Automatic session rehydration    | `agent_sessions` + `platform_sessions` | `authorizeControl` resumes from the store when the session is not in memory (`src/platform/session-manager.ts:249-262`) → `resumeAgentSession` loads messages (`src/core/agent-session.ts:78-85`)                                                                                   |
| Monotonic post-restart sequences | `platform_events`                      | Last stored sequence read at run start, then an offset applied to emitted events (`src/platform/session-manager.ts:110-121`); the unique `{tenantId, sessionId, sequence}` index is the backstop                                                                                    |
| Orphaned-run recovery            | `platform_runs`                        | `recoverOrphanedRuns` at startup marks every `running` row failed (`src/platform/session-manager.ts:49`, `src/platform/mongodb-runtime.ts:90-102`)                                                                                                                                  |

Every one of `platform_runs`, `platform_events`, `agent_sessions`, and
`platform_sessions` looks idle under normal operation and is load-bearing only at
restart, retry, or replay. `PLATFORM_COMPLETION_AUDIT.md:14-16` states the
service runs all runs in one API process and depends on exactly this behaviour on
restart.

**Partial deletion is more dangerous than full deletion.** Dropping
`platform_events` entirely resets the sequence baseline to 0 consistently.
Deleting _some_ events for a session leaves a stale baseline, and the offset
arithmetic at `src/platform/session-manager.ts:110-121` can then produce a
sequence that already exists, which makes `appendEvent` throw a duplicate-key
error mid-run. Any pruning or TTL added to `platform_events` must be
session-complete, not time-based.

---

## Part 4 — Verdict

### Per collection

| Collection                   | Recommendation                          | Reasoning                                                                                                                     |
| ---------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `agents`                     | **Keep**                                | Root identity; every other control-plane collection references it                                                             |
| `agent_versions`             | **Keep**                                | Sole store of agent definitions and the checksum that reaches the system prompt                                               |
| `agent_deployments`          | **Merge into `agents`**                 | Three meaningful fields plus a counter, one document per `(agent, environment)`; embeds as an `environments` map with no loss |
| `platform_audit`             | **Keep, deprioritise**                  | Nothing reads it in any product flow, but it is unreconstructable and may be retained for compliance                          |
| `platform_api_keys`          | **Keep**                                | Authentication material; dropping locks out clients irreversibly                                                              |
| `agent_sessions`             | **Keep separate, but bound `messages`** | Do not merge into `platform_sessions`: that collection is read on every authorization and must stay small                     |
| `platform_sessions`          | **Keep**                                | Control-token hash, ownership, and open/closed status — the session authorization record                                      |
| `platform_runs`              | **Keep**                                | The unique index _is_ the idempotency guarantee                                                                               |
| `platform_events`            | **Keep**                                | Replay and monotonic sequencing; add session-complete retention, not TTL                                                      |
| `platform_secrets`           | **Investigate, do not drop**            | Unreferenced by `src/` but holds a plaintext credential; rotate the value regardless                                          |
| `platform_model_providers`   | **Investigate, do not drop**            | The likely target of `providerRef` in stored definitions                                                                      |
| `platform_trusted_base_urls` | **Drop after confirming ownership**     | `src/` implements the same allowlist from an env var                                                                          |
| `platform_prompts`           | **Drop**                                | Empty, unreferenced, no reconstructable purpose                                                                               |

### Three collections carrying the most complexity for the least value

1. **`agent_sessions`.** Its content duplicates what `platform_events` already
   records via `assistant.message.completed` and `tool.completed`. It carries the
   only unbounded-document risk in the system, and its whole-document
   `replaceOne` per turn makes write cost quadratic in session length. Its sole
   consumer is `resumeAgentSession`. Rebuilding history from `platform_events` on
   resume would remove a collection, the 16MB ceiling, and the write
   amplification in one move — at the cost of a fold over the event log.
2. **`platform_audit`.** 11 documents, an index whose middle key defeats the only
   query that uses it, and no reader outside one admin endpoint. It implies
   immutability it does not enforce. Either commit to it properly — narrower
   index, retention policy, tamper-evidence — or fold it into an events table.
3. **`agent_deployments`.** A dedicated collection, a unique compound index, and
   an upsert-with-`$inc` dance to maintain a pointer and a counter. It is a
   sub-document of `agents` wearing a collection costume.

### Complexity that is actually load-bearing

Do not simplify these. Each looks like over-engineering and is not:

- **`platform_runs`' unique index plus the error-11000 catch**
  (`src/platform/mongodb-runtime.ts:83, 141`). This _is_ the idempotent-run-ID
  guarantee. Remove it and a client retry double-executes an agent run.
- **`platform_events`' unique `{tenantId, sessionId, sequence}` index and the
  `sequenceOffset` arithmetic** (`src/platform/mongodb-runtime.ts:84`,
  `src/platform/session-manager.ts:110-121`). Guarantee: monotonic event
  sequences across process restarts, so a reconnecting client can resume from a
  cursor without gaps or duplicates.
- **`recoverOrphanedRuns`' cross-tenant `updateMany`**
  (`src/platform/mongodb-runtime.ts:90-102`). It violates tenant scoping on
  purpose. Guarantee: orphaned-run recovery — without it, runs killed with the
  process stay `running` forever and their `runId` can never be retried.
- **`agent_versions` immutability plus `checksum`**
  (`src/platform/definitions.ts:211`). The checksum is not decorative: it is
  embedded in the composed system prompt (`src/platform/execution.ts:171,
262-266`), so the model's instructions are pinned to an exact definition.
  Guarantee: reproducible runs and meaningful rollback.
- **`agent_deployments.revision`** (`src/platform/mongodb-store.ts:133`).
  Monotonic per environment and surfaced in session metadata and audit records;
  it distinguishes a rollback from the original publish of the same version.
- **`agent_sessions`' existence at all.** Guarantee: automatic session
  rehydration after restart (`PLATFORM_COMPLETION_AUDIT.md:28`).

### Minimum viable schema

Collections and key fields only. `_id` is left to MongoDB in all cases.

| Collection          | Key fields                                                                                                                                  | Notes                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants`           | `tenantId` (unique), `name`, `status`, `createdAt`                                                                                          | **New.** Does not exist today; `tenantId` is currently an unvalidated string with no registry. Needed before tenant scoping means anything                   |
| `agents`            | `tenantId`, `id`, `slug`, `name`, `versionCounter`, `archivedAt?`, `environments: { [env]: { versionId, revision, updatedAt, updatedBy } }` | Absorbs `agent_deployments`. Unique on `{tenantId, slug}` and `{tenantId, id}`                                                                               |
| `agent_versions`    | `tenantId`, `agentId`, `id`, `version`, `checksum`, `definition`                                                                            | Immutable. Unique on `{tenantId, agentId, version}` and `{tenantId, agentId, id}`                                                                            |
| `platform_sessions` | `tenantId`, `sessionId`, `ownerId`, `agentIdOrSlug`, `environment`, `controlTokenHash`, `status`, `lastSequence`, `updatedAt`               | Add `lastSequence` so run start stops scanning the whole event log. Must stay small — no message history here                                                |
| `platform_runs`     | `tenantId`, `sessionId`, `runId`, `status`, `createdAt`, `updatedAt`, `error?`                                                              | Keep the unique `{tenantId, sessionId, runId}` index; add `{status}` for orphan recovery                                                                     |
| `platform_events`   | `tenantId`, `sessionId`, `runId`, `sequence`, `event`, `createdAt`                                                                          | Drop the redundant `id`; `{tenantId, sessionId, sequence}` is already a unique key. Drop `event.sequence` and `event.sessionId` on write, re-hydrate on read |

Deliberately absent: `agent_sessions` (fold history into `platform_events` or cap
it), `platform_audit` (retain as-is only if compliance requires it), and all four
unreferenced collections.

### Migration risk

| Collection                                               | Data to preserve                                                        | Move required                                                                                                                                                                                             | Risk                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_deployments` → `agents.environments`              | Yes — `versionId` and `revision` per environment are live routing state | Yes. Read each deployment, `$set` into the parent agent, verify counts, then drop                                                                                                                         | Low. 2 documents here, small everywhere. Non-atomic across two collections; do it with the API stopped                                                                                                                                         |
| `agent_sessions` → derived from `platform_events`        | Yes if resume must keep working for existing open sessions              | Either backfill history from `assistant.message.completed` and `tool.completed` events, or accept that pre-migration sessions cannot be resumed                                                           | **High.** Tool results are truncated in the message history at ~100_000 chars with the full text in the artifact store, so an event-derived rebuild is not byte-identical. Verify a rebuilt session produces the same prompt before committing |
| `platform_audit`                                         | Yes if retained for compliance                                          | Export before any change; do not transform in place                                                                                                                                                       | Low technically, potentially high legally. Get a retention answer before touching it                                                                                                                                                           |
| `platform_events` field trimming                         | Yes — the events themselves                                             | Removing `id` and the duplicated `event.sequence` / `event.sessionId` requires a rewrite of every document                                                                                                | Medium. `listEvents` reconstructs `AgentEvent` objects from `record.event` (`src/platform/mongodb-runtime.ts:183`), so the read path must repopulate the stripped fields or clients receive malformed protocol-v1 events                       |
| `platform_secrets`                                       | Unknown ownership; contains a credential                                | Do not migrate. Identify the owner, move the value to the environment-based resolver, then rotate it                                                                                                      | **High.** A plaintext credential in an unauthenticated database should be rotated whether or not the collection is dropped                                                                                                                     |
| `platform_model_providers`, `platform_trusted_base_urls` | Only if the divergent build stays in service                            | Reconcile with `PLATFORM_ALLOWED_MODEL_BASE_URLS` and `modelBindingSchema` first                                                                                                                          | Medium. Dropping these while stored definitions still carry `providerRef` leaves agents unable to resolve a model                                                                                                                              |
| `platform_prompts`                                       | No                                                                      | None                                                                                                                                                                                                      | None. Empty                                                                                                                                                                                                                                    |
| Stored `providerRef` definitions                         | Yes                                                                     | Independent of any drop decision: existing `agent_versions` documents must gain `secretRef` (and `baseURL` where the provider is `openai-compatible`) or no agent in this database can run against `src/` | **High and already broken.** Fix this before, not during, the simplification                                                                                                                                                                   |

### Blocking issue

The `providerRef` / `secretRef` divergence means the current `src/` cannot execute
any agent version stored in this database. Resolve which build owns
`trueai_agent_platform` — and therefore whether `platform_secrets` and
`platform_model_providers` are authoritative — before making any schema decision.
Simplifying against `src/` while the data belongs to a different build would
compound the drift rather than remove it.

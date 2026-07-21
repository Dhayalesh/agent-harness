# Agent event protocol v1

Every event contains:

- `protocolVersion: 1`;
- a session-local monotonic `sequence`;
- ISO-8601 `timestamp`;
- `sessionId`;
- a discriminating `type` and type-specific fields.

The protocol is JSON serializable and is shared by in-process SDK consumers,
JSONL automation, SSE/WebSocket gateways, desktop IPC, and IDE bridges. Unknown
event types must be ignored by forward-compatible consumers. A breaking field or
semantic change requires a new protocol version.

Tool permission requests are asynchronous. A controller responds using the
opaque `requestId`; observers never receive the session control token.

Gateway replay uses `sequence` as its cursor. Run idempotency keys prevent a
reconnected consumer from executing the same user request twice.

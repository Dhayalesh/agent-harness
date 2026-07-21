# ADR 0002: Provider-neutral internal messages

- Status: accepted

Messages, tool calls, events, usage, and stop reasons use harness-owned types.
Provider SDK types are translated at model-adapter boundaries. This permits
multiple providers and deterministic tests without leaking vendor semantics
through the rest of the runtime.

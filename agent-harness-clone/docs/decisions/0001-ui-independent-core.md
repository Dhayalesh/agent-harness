# ADR 0001: UI-independent harness core

- Status: accepted

The agent runtime exposes a session control API and serializable event stream.
Terminal, web, desktop, IDE, and SDK code are consumers. The core cannot import
surface-specific UI frameworks.

This direction makes the harness usable in-process and across JSONL, IPC,
WebSocket, or SSE transports without duplicating the agent loop.

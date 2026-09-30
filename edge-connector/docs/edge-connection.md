# Edge connection layer

## Architecture

`edge.exe` opens one outbound WebSocket to the separate `edge-server` application. The server is a transport router. Edge retains its existing local MCP router and embedded SAP ADT MCP host; routed MCP requests are handled locally. Harness integration is not implemented yet.

An outbound connection works for standard Windows users behind typical customer firewalls and NAT. `edge.exe` does not listen on an inbound port. The separate server binds to `127.0.0.1:8080` by default.

## Identity and configuration

The existing Edge configuration abstraction loads `%LOCALAPPDATA%\TrueAI\Edge\config.json` by default. `--config` can select another JSON file. The default server URL is `wss://edge-server-conector.duckdns.org/ws`. A saved `serverUrl` overrides that default, and `--server` overrides and saves the selected URL. Connection settings also include `userEmail` and `deviceId`; a saved legacy `tenantId` is ignored for Edge Server routing. `--email` overrides and saves the email. On normal startup, Edge prompts if email is missing and creates the device ID. A tenant is not required. An explicitly empty `serverUrl` in the config preserves local MCP mode without an Edge Server connection.

The device ID is 16 cryptographically random bytes encoded as `edge-` plus 32 hexadecimal characters. It is generated once and reused. It does not derive from hardware, username, or machine identifiers. The config does not contain SAP passwords. Email is an unverified routing identifier, not proof of identity; the MVP has no authentication credentials or email verification. `wss://` is required for nonlocal connector URLs. Local `ws://` is permitted only for loopback.

## Protocol

Messages are JSON with `version: 1` and a `type`. Edge first sends `edge.register` with a random `requestId` and top-level `email` and `deviceId`. The server requires a nonempty email, stores it as the active connection key, and replaces an earlier connection for the same email. It replies `edge.registered` using the same `requestId` and a nonempty internal `connectionId`. Edge rejects malformed responses, unsupported versions, and unknown message types. Registration is limited to 4096 bytes and must complete within 10 seconds. Routed MCP messages have an 8 MiB frame limit.

Once ready, Edge sends `edge.heartbeat` with its device ID every 30 seconds. The server replies `edge.heartbeat_ack` with `serverTime`. Edge waits up to 10 seconds for each acknowledgement. A missing acknowledgement, closed socket, or invalid message causes a reconnect. Backoff starts at 1 second and doubles to a 30 second cap, with 80-100% jitter; successful registration resets it. Ctrl+C sends `edge.disconnect` and closes the socket. Heartbeat and timeout values can be shortened in manager tests.

Connection states are `DISCONNECTED`, `CONNECTING`, `CONNECTED`, `REGISTERING`, `READY`, `RECONNECTING`, and `STOPPING`. Edge logs each transition and the actual dial, upgrade, read, write, and protocol errors. Local `ws://localhost` connections dial `127.0.0.1` so another service bound to IPv6 `::1` cannot intercept the development connection.

## Local development

For local development, from `edge-connector/`, run:

```powershell
cd ../edge-server
go run ./cmd/server
```

In a second terminal:

```powershell
go build -o edge.exe ./cmd/edge
.\edge.exe --server ws://127.0.0.1:8080/ws --email user@company.com
```

The server stores active email connections and pending request correlations in memory. Stop it to observe Edge reconnecting; restart it to observe a fresh registration. The server needs no token configuration. Authentication is deferred beyond this MVP.

Run all tests and vet from this directory:

```powershell
go test -count=1 ./...
go vet ./...
```

## Security boundary and deferred work

The Edge connection manager recognizes registration and heartbeat acknowledgements and routed `edge.mcp.request` messages. The local handler supports `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, and `ping`. Tool execution passes through the existing local router and policy. The server does not execute tools, read SAP credentials, or expose an MCP client. The Harness `EdgeClientTransport` remains future work.

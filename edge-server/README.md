# True.ai Edge Server

Independent Go WebSocket transport/router for EC2. It contains no SAP ADT runtime, SAP credentials, MCP tool executor, or second cloud MCP client.

## MVP identity and registration

Email is an unverified identifier. The server requires a nonempty email, keeps one active WebSocket connection per email, and replaces the previous connection when the same email registers again. It generates a new internal `connectionId` for each connection. No token, password, API key, OAuth, JWT, email verification, or external identity provider is used.

The connector sends:

```json
{"version":1,"type":"edge.register","requestId":"...","email":"user@company.com","deviceId":"..."}
```

The server replies with `edge.registered` using the same `requestId` and a payload containing `connectionId`. Existing `edge.heartbeat` / `edge.heartbeat_ack`, reconnect, and `edge.disconnect` behavior remains. `deviceId` is connection metadata and the heartbeat check; routing uses email.

## Run locally

```powershell
cd edge-server
go run ./cmd/server
```

The default listener is `127.0.0.1:8080`. In `edge-connector/`, after the existing local SAP setup is available:

```powershell
go build -o edge.exe ./cmd/edge
.\edge.exe --server ws://127.0.0.1:8080/ws --email user@company.com
```

The server needs no token or credential configuration. An optional WSS listener can be started with `--listen`, `--tls-cert`, and `--tls-key`. The connector requires WSS for nonlocal server URLs.

## MCP relay

The planned Harness `EdgeClientTransport` will connect to `/harness/ws` and send `harness.mcp.request` with `{email,mcpId,message}`. The server looks up the active connection by email, forwards the opaque JSON-RPC `message` as `edge.mcp.request`, and returns `harness.mcp.response` or `harness.mcp.error`. The current Harness has no client for this endpoint. This server keeps connections and pending requests in memory, so multiple server instances would need connection affinity or shared routing state.

## Build and test

```powershell
go test ./...
go build -o edge-server.exe ./cmd/server
```

This project has its own Go module and version. It does not import `edge-connector` or `agent-harness-clone`.

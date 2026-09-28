# Go SAP GUI POC verification (2026-09-29)

## Passed

- `go test ./...` in `gui-edge-server`: health, registration, heartbeat, MCP relay, image content preservation, malformed JSON, timeout and reconnect tests passed.
- `go test ./...` in `edge-connector-gui`: configuration persistence, connector registration and reconnect, image content relay, real upstream MCP initialization, real tools/list and read-only `sap_list_connections` passed. The real upstream process stayed alive across calls.
- Go server build: `gui-edge-server\dist\gui-edge-server.exe`.
- Go connector build: `edge-connector-gui\dist\edge-gui.exe`, with the upstream Python runtime embedded inside it.
- Packaged Go end-to-end: Go server + Go connector + upstream runtime returned MCP server name `sap-desktop-mcp`, **62 actual tools** and one content block from the read-only tool call.
- Packaged connector sent a heartbeat and received `edge.heartbeat_ack`. After the Go server was stopped and restarted, the same connector re-registered and the second Go probe returned the same tool count and read-only tool result.
- Existing `edge-connector`, `edge-server`, `agent-console` and `agent-harness-clone` files were not changed.

## Pending live SAP test

No running SAP GUI session or test SAP system was available here. A live SAP GUI COM read, multi-session selection against real sessions, and screenshot return still require a Windows test desktop with SAP GUI Scripting enabled. No destructive SAP operation was attempted.

## Build and run commands used

```powershell
cd gui-edge-server
.\build.ps1
$env:GOCACHE = Join-Path $PWD '.gocache'
go test ./...

cd ..\edge-connector-gui
.\build.ps1
.\build.ps1 -SkipUpstreamBuild
$env:GOCACHE = Join-Path $PWD '.gocache'
go test ./...
```

The full connector build script built the upstream standalone executable from its own `sapgui_mcp_windows.spec` using the prepared `sapgui.mcp\.venv` Python environment, then embedded it in the Go executable. `.\build.ps1 -SkipUpstreamBuild` reuses an already built upstream asset for Go-only edits.

For the packaged check, the Go server ran with `-listen 127.0.0.1:18766`, the Go connector ran with `EDGE_GUI_HOME` pointing to a test config, and the Go probe ran twice:

```powershell
go run .\cmd\probe -url ws://127.0.0.1:18766/ws -email go-poc@example.com
```

The Go server was restarted between probe runs. Both probe runs reported `sap-desktop-mcp`, 62 tools and one read-only content block.

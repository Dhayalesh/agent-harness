# Go SAP GUI edge connector POC

`edge-gui.exe` is a Go application. It embeds the unmodified standalone Windows executable built from [Hochfrequenz sapgui.mcp](https://github.com/Hochfrequenz/sapgui.mcp), extracts it by SHA-256 to `%LOCALAPPDATA%\TrueAI\EdgeGUI\runtime`, and owns one persistent MCP stdio process. The upstream `DesktopBackend` performs SAP GUI COM/Scripting work locally. The Go connector owns configuration, logging, WebSocket registration, heartbeat, reconnect, MCP request routing and response forwarding. It has no runtime dependency on the existing `edge-connector` or `edge-server`.

## Build

Prerequisites for building: Go 1.22+, Windows x64, the sibling `../sapgui.mcp` source, Python 3.11+ and PyInstaller in the upstream build environment. The local source inspected for this POC was commit `1d892d13f7e2ac146e8fd866320c3f502a9225e0`.

```powershell
cd edge-connector-gui
.\build.ps1
```

The script builds upstream using its own `sapgui_mcp_windows.spec`, embeds the resulting executable in the Go binary, and writes `dist\edge-gui.exe` plus the upstream MIT license. If the upstream build environment is prepared elsewhere, pass `-UpstreamPython C:\path\to\python.exe`. For Go-only edits after the upstream asset has been built, use `.\build.ps1 -SkipUpstreamBuild`.

The upstream executable in `internal\runtime` is a generated, ignored build asset. The installed user needs only the distributed Go `edge-gui.exe`; Python, uv and a separately started MCP server are not needed at run time. GUI Edge writes its own SAP system definition at `%LOCALAPPDATA%\TrueAI\EdgeGUI\systems.json` and passes its path to the embedded MCP process.

## Configure and run

```powershell
.\dist\edge-gui.exe
```

First run creates `%LOCALAPPDATA%\TrueAI\EdgeGUI\config.json`, `logs`, `state` and `runtime`. The console then asks for the registered email, SAP Logon connection name (or connection string), SAP system URL, three-digit client, username, language and password. The connection name must match the entry in SAP Logon. The upstream SAP configuration schema also requires the URL, even though desktop scripting opens the SAP Logon entry. Password input is masked. The password is stored in the current Windows user's Credential Manager; `systems.json` contains only an environment-variable reference, and the password is supplied to the embedded MCP process at launch. No SAP credentials are sent to GUI Edge Server.

Subsequent runs load the saved settings and show live startup, registration, heartbeat and reconnect logs in the console and `%LOCALAPPDATA%\TrueAI\EdgeGUI\logs\edge-gui.log`. Use `edge-gui.exe --setup` to re-enter email and SAP settings or `edge-gui.exe --change-account` to change only the registered email. Run only one instance for the same email and MCP ID.

The Edge connection file contains only transport identity and timing settings:

```json
{
  "serverUrl": "wss://gui-edge-server.duckdns.org/ws",
  "email": "user@example.com",
  "deviceId": "generated-and-persisted",
  "mcpId": "sapgui",
  "heartbeatSeconds": 30
}
```

Remote servers require `wss://`. `EDGE_GUI_HOME` overrides the configuration root for testing. The connector retains the same MCP process across WebSocket reconnects and tool calls. If the upstream process exits or times out, the next request starts a new upstream process. It logs method names and tool count, never request payloads or SAP credentials.

## SAP GUI prerequisites

- Windows with SAP GUI for Windows installed.
- SAP GUI Scripting enabled in SAP GUI options and on the SAP system (`sapgui/user_scripting = TRUE`).
- A test SAP session for live read operations. The upstream can manage multiple sessions through its own session registry and `session` tool parameters.
- The SAP Logon entry named during setup must exist on the Windows desktop. Do not put SAP passwords in Edge config or Agent Console.

Missing SAP GUI, disabled scripting or an unavailable session returns an upstream MCP tool error; the Go connector remains connected. It forwards MCP content, including images and structured data, as JSON without converting it to text.

## Tests

```powershell
$env:GOCACHE = Join-Path $PWD '.gocache'
go test ./...
```

Tests include real upstream initialize, live tool discovery and the read-only `sap_list_connections` tool. That call does not require a SAP login. A live SAP GUI read and screenshot still require a Windows test desktop and test system. See [test results](TEST_RESULTS.md).

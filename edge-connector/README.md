# True.ai Edge Connector

## Outbound Edge connection

The Edge connector keeps an outbound WebSocket connection to the separate `edge-server` application. It registers its email and locally generated device ID, sends application heartbeats, reconnects with capped exponential backoff, and handles routed MCP requests through its existing local router. The embedded ADT MCP runtime and local CLI remain available. Harness integration is a later task.

The default production endpoint is `wss://edge-server-conector.duckdns.org/ws`. An existing saved `serverUrl` or an explicit `--server` value overrides that default.

Run the separate server in local development:

```powershell
cd ../edge-server
go run ./cmd/server
# In edge-connector/, in another terminal:
go build -o edge.exe ./cmd/edge
.\edge.exe --server ws://localhost:8080/ws --email user@company.com
```

On first connection startup, Edge stores `serverUrl`, `userEmail`, and a random stable `deviceId` in `%LOCALAPPDATA%\TrueAI\Edge\config.json`. The Edge Server uses only the email to identify the active connection. Without `--email`, Edge prompts for it. Later runs reuse the saved values. Press Ctrl+C to send `edge.disconnect` and stop. The customer executable needs no separately installed Node.js, Go, or MCP host.

See [Edge connection guide](docs/edge-connection.md) for protocol, security limits, and local testing.

Standalone local out-of-process Model Context Protocol (MCP) supervisor and deterministic router for Windows.

---

## Overview

The **True.ai Edge Connector** bridges AI agent runtimes to local corporate systems (starting with SAP ABAP ADT) without requiring administrative privileges on Windows. It supervises external MCP processes via standard input/output (`stdio`), enforces local execution and safety policies, recovers from process crashes, and dynamically discovers available tools.

```
+─────────────────────────────────────────────────────────────+
|                     Standard Windows User                   |
+─────────────────────────────────────────────────────────────+
                              │
                              ▼
+─────────────────────────────────────────────────────────────+
|                 True.ai Edge Connector (Go)                 |
|                                                             |
|  - Embedded Native MCP Host & Dynamic Discovery             |
|    (Single customer executable `edge.exe` with zero runtime  |
|     prerequisites: No Node.js, npm, npx, Python, or Docker)  |
|  - Configurable Env-File & System Type Resolution            |
|  - Destination-based Selection (e.g. DEV, PROD)             |
|  - Process Supervisor (stdio, backoff, crash protection)    |
|  - JSON-RPC 2.0 Protocol Client                             |
|  - Deterministic Policy & Argument Sanitization             |
|  - Non-Admin Windows Runtime (%LOCALAPPDATA%\TrueAI\Edge)   |
+──────────────────────────────┬──────────────────────────────+
                               │ stdio (JSON-RPC 2.0)
                               │ [sap-adt-host.exe --transport=stdio --env-path=<path> --system-type=onprem]
                               ▼
+─────────────────────────────────────────────────────────────+
|           Embedded SAP ABAP ADT MCP Host Process            |
|        (Self-extracted Apache-2.0 Node SEA standalone host) |
+──────────────────────────────┬──────────────────────────────+
                               │ SAP Connection / Auth
                               │ (Loaded by host process via --env-path or service keys)
                               ▼
+─────────────────────────────────────────────────────────────+
|                      SAP NetWeaver / S/4HANA                |
+─────────────────────────────────────────────────────────────+
```

---

## Key Features

- **Single Executable Delivery (`edge.exe`)**: Embeds the standalone SAP ADT MCP host directly inside `edge.exe`. Customers are **not** required to install Node.js, npm, npx, Python, or Docker.
- **Windows Non-Admin Model**: Runs cleanly under standard Windows user accounts. User state, extracted runtime, and logs default to `%LOCALAPPDATA%\TrueAI\Edge`.
- **Integrity Verification & Fast-Path Extraction**: Verifies embedded binary SHA-256 against disk cache. Subsequent executions launch instantly with 0ms extraction overhead. Recovers automatically from corrupted or tampered files.
- **Strict License Compliance**: The standalone host is constructed entirely using `@mcp-abap-adt/lib` (Apache-2.0) and `@modelcontextprotocol/sdk` (MIT). `@mcp-abap-adt/core` (AGPL-3.0) is strictly never imported or bundled.
- **Configurable Environment & System Type**: Passes `--env-path=<resolved-path>` and `--system-type=onprem` to the external MCP. Relative paths are resolved locally by Edge, while absolute Windows paths are preserved. Edge never reads, parses, or transmits the file contents.
- **Destination-Based Selection**: When destinations (e.g. `DEV`, `PROD`) are configured, they are passed strictly via CLI arguments:
  ```powershell
  <executable> --transport=stdio --env-path=<resolved-path> --system-type=onprem --mcp=<destination>
  ```
  Edge does **not** invent or inject unverified environment variables like `SAP_DESTINATION`.
- **Credential Segregation**: SAP credentials and connection parameters remain owned and consumed exclusively by the external ADT MCP. Edge never reads, stores, proxies, or logs credentials.
- **Process Supervision & Lifecycle**: Auto-starts, monitors, and gracefully shuts down MCP child processes. Tracks PIDs, uptimes, restart counts, and exit codes.
- **Crash Recovery & Restart-Loop Protection**: Configurable exponential backoff and crash window thresholds protect the machine against infinite restart loops.
- **Dynamic Tool Discovery**: Dynamically queries and caches exposed tools upon startup (`tools/list`), logging tool schemas without hard-coding SAP ADT tools.
- **Deterministic Routing**: Requests are mapped strictly to declared manifests and verified tools. Arbitrary execution arguments (`cmd`, `powershell`, `executable`) are strictly rejected.
- **Structured Logging**: Built with Go's standard `log/slog` with automatic secret sanitization.

---

## Project Structure

```
edge-connector/
├── cmd/
│   └── edge/
│       └── main.go                 # Application entrypoint & graceful shutdown
│
├── internal/
│   ├── config/                     # Configuration loader & %LOCALAPPDATA% path resolver
│   ├── health/                     # Local health & process status monitor
│   ├── logging/                    # Structured slog logger with credential redaction
│   ├── mcp/
│   │   ├── manifest/               # Manifest parser, destination & arg resolver
│   │   ├── process/                # Process manager, supervisor, & crash recovery
│   │   ├── protocol/               # MCP JSON-RPC 2.0 stdio client & handshake
│   │   ├── registry/               # Manifest indexing & process registry
│   │   └── router/                 # Deterministic router & call pipeline
│   └── policy/                     # Whitelist policy & execution safety engine
│
├── mcp/
│   └── manifests/
│       └── sap-adt.yaml            # Manifest definition for SAP ABAP ADT MCP
│
├── tests/
│   ├── fixtures/
│   │   └── fake-mcp/
│   │       └── main.go             # Standalone fake MCP for offline testing
│   ├── e2e_test.go                 # Local end-to-end fake MCP integration test
│   └── real_mcp_test.go            # Separated Real SAP ADT MCP integration test
│
├── docs/
│   ├── architecture.md             # Detailed system architecture & components
│   ├── mcp-runtime.md              # Process supervision & protocol details
│   ├── configuration.md            # Configuration options & %LOCALAPPDATA% layout
│   ├── security.md                 # Security boundaries & non-admin model
│   └── testing.md                  # Test suite & verification strategy
│
├── AGENTS.md                       # Developer & autonomous agent guidelines
├── ARCHITECTURE.md                 # High-level architecture documentation
├── README.md                       # This file
└── go.mod                          # Go module definition
```

---

## Building & Running

### Prerequisites
- Go 1.22+ installed (build time only)
- An external MCP executable is optional for development overrides; customer mode uses the embedded ADT host.

### Build
```powershell
# Build True.ai Edge Connector binary
go build -o edge.exe ./cmd/edge

# Build External Fake MCP binary for testing
go build -o fake-mcp.exe ./tests/fixtures/fake-mcp
```

### Executable-Level Testing (edge.exe + fake-mcp.exe)
```powershell
# Describe a tool's schema and parameters
.\edge.exe --sap-executable .\fake-mcp.exe --describe-tool read_abap_class

# Execute tool call directly through compiled edge.exe and exit cleanly
.\edge.exe --sap-executable .\fake-mcp.exe --destination DEV --call-tool read_abap_class --call-args '{\"class_name\":\"ZCL_CUSTOMER_INVOICE\"}'

# Verify process supervisor crash detection and automatic restart recovery
.\edge.exe --sap-executable .\fake-mcp.exe --destination DEV --test-restart
```

### Customer Mode (Zero Prerequisites, Single Executable)
Customers receive only `edge.exe` with no external folder requirements:
```powershell
# Run edge.exe with zero external folders or prerequisite runtimes
.\edge.exe

# Describe any SAP ADT tool schema (discovers all 206 tools dynamically out of the box)
.\edge.exe --describe-tool GetObjectsList

# View Edge version
.\edge.exe --version
```

### Development & Integration Mode
Developers can override settings via CLI flags or point to external environments:
```powershell
# Run with explicit development env file (SAP NetWeaver / S/4HANA credentials)
.\edge.exe --sap-env-path ".\DEV.env" --sap-system-type onprem

# Describe real SAP ADT tool schema with explicit development env file
.\edge.exe --sap-env-path ".\DEV.env" --sap-system-type onprem --describe-tool GetObjectsList

# Run with explicit external manifest directory (development override)
.\edge.exe --manifests ".\mcp\manifests"

# Run with explicit external MCP executable path
.\edge.exe --sap-executable "C:\Tools\mcp-abap-adt.exe" --sap-env-path ".\DEV.env" --sap-system-type onprem --log-level debug
```

---

## Running Tests

### Normal Automated Tests (Offline, Zero SAP Dependency)
All unit tests and the Fake MCP E2E test run offline without SAP credentials:
```powershell
go test -count=1 ./...
```

### Real SAP ADT MCP Integration Test (Manual / Explicit)
To run the integration test against the real SAP ADT MCP:
```powershell
# Set activation flag
$env:TRUEAI_TEST_REAL_SAP="1"

# Optional overrides:
$env:TRUEAI_SAP_ENV_PATH=".\DEV.env"
$env:TRUEAI_SAP_SYSTEM_TYPE="onprem"
$env:TRUEAI_SAP_DESTINATION="DEV"
$env:TRUEAI_SAP_EXECUTABLE="C:\path\to\mcp-abap-adt"

# Execute real integration test
go test -v -run TestRealSAPADTMCPIntegration ./tests
```

---

## Documentation Index

- [Architecture Guide](docs/architecture.md)
- [MCP Runtime & Supervision](docs/mcp-runtime.md)
- [Configuration Reference](docs/configuration.md)
- [Security & Non-Admin Model](docs/security.md)
- [Testing Strategy](docs/testing.md)

# Single-Executable Distribution & Runtime Architecture

## 1. Vision & Architecture

The True.ai Edge Connector is delivered as a single, self-contained Windows executable:

```
    edge.exe (Single customer executable)
       │
       ├─► Uses Embedded Manifest (sap-adt.yaml)
       │
       ├─► Auto-Extracts & SHA-256 Verifies
       ▼
    %LOCALAPPDATA%\TrueAI\Edge\runtime\sap-adt-host.exe (Standalone Apache-2.0 Node SEA Host)
       │
       │ (out-of-process execution over JSON-RPC 2.0 stdio)
       ▼
    SAP ADT MCP Process (@mcp-abap-adt/lib - Apache-2.0)
       │
       │ (HTTPS / RFC via customer-configured DEV.env or %LOCALAPPDATA%\TrueAI\Edge)
       ▼
    SAP NetWeaver / S/4HANA (DEV)
```

The customer experience requires **zero prerequisite installations**:
- **No Node.js**
- **No npm / npx**
- **No Python**
- **No Docker**
- **No separate MCP installation**
- **No external manifest folder (`mcp\manifests`) required**

The customer receives exactly one file: `edge.exe`.

---

## 2. Technical Implementation

### A. Embedded Default Manifest (`assets/manifests/sap-adt.yaml`)
Edge embeds the default `sap-adt` manifest directly into the compiled executable:
```yaml
id: sap-adt
name: SAP ABAP ADT MCP
version: 1.0.0
transport: stdio
executable: sap-adt-host
systemType: onprem
arguments:
  - "--transport=stdio"
startupTimeout: 30s
requestTimeout: 60s
restartPolicy:
  maxRestarts: 5
  crashWindow: 60s
  initialBackoff: 1s
  maxBackoff: 30s
allowedTools:
  - "*"
```
- **Zero Credentials**: Contains no passwords, usernames, tokens, or service keys.
- **Embedded via Go**: Embedded via `assets.EmbeddedDefaultManifest` and registered dynamically if no external manifest directory is supplied.

### B. Independent Standalone Host (`adt-host/`)
To satisfy licensing constraints without importing `@mcp-abap-adt/core` (AGPL-3.0), True.ai Edge built an independent standalone host under `edge-connector/adt-host/host.js`:
- **Libraries used**:
  - `@mcp-abap-adt/lib` (Apache-2.0) — provides `EmbeddableMcpServer`, `AuthBrokerFactory`, and all 206 ADT handler tool definitions.
  - `@mcp-abap-adt/connection` (Apache-2.0) — handles direct SAP connection lifecycle.
  - `@modelcontextprotocol/sdk` (MIT) — provides standard JSON-RPC 2.0 `StdioServerTransport`.
- **License Compliance**: Zero AGPL code is imported, linked, or vendored.
- **Connection Model**: Stdio transport connects immediately upon launch to guarantee instantaneous MCP `initialize` handshakes.
- **Customer / Unconfigured Mode**: When run with no environment file, safe placeholder parameters allow immediate discovery and schema inspection of all 206 tools without failing or timing out.

### C. Node Single Executable Application (SEA) Packaging
The standalone host is compiled into a fully self-contained native Windows executable (`sap-adt-host.exe`, ~87 MB):
1. **Bundle Generation**: `esbuild` bundles `host.js` and all dependencies into a single CommonJS bundle (`bundle.cjs`).
2. **Blob Generation**: Node compiles `bundle.cjs` into a V8 startup snapshot SEA blob (`sea-prep.blob`).
3. **Binary Injection**: The base `node.exe` has its digital Authenticode signature cleanly stripped (by zeroing `IMAGE_DIRECTORY_ENTRY_SECURITY` in the PE32+ header and truncating the security certificate table), then `postject` injects the SEA blob into the `NODE_SEA_BLOB` resource.

### D. Go Embedded Runtime (`internal/runtime/`)
The compiled `sap-adt-host.exe` is placed into `assets/mcp/sap-adt-host.exe` and embedded directly into `edge.exe` via Go 1.16+ embed:
```go
package assets

import _ "embed"

//go:embed mcp/sap-adt-host.exe
var EmbeddedHostBinary []byte

//go:embed manifests/sap-adt.yaml
var EmbeddedDefaultManifest []byte
```

At runtime, `internal/runtime/embedded.go` handles lifecycle management:
1. **Target Directory**: `%LOCALAPPDATA%\TrueAI\Edge\runtime\sap-adt-host.exe`.
2. **SHA-256 Integrity Verification**:
   - Computes SHA-256 of the embedded binary and checks disk state.
   - **Fast Path**: If the file exists and the hash matches, extraction is skipped entirely (0ms overhead on startup).
   - **Tamper Recovery**: If the on-disk binary is modified, corrupt, or truncated, Edge automatically replaces it with the embedded binary.
3. **Atomic File Creation**:
   - Writes to a temporary file (`sap-adt-host.exe.tmp.<pid>`), flushes disk buffers, and atomically renames (`os.Rename`) to prevent partial writes.

---

## 3. Customer Mode vs. Development Mode

### Customer Mode (Default)
When executed without flags or configuration directories:
- Edge uses the embedded `sap-adt` manifest.
- Edge does **not** search for or warn about missing `mcp\manifests\`.
- Extracts `sap-adt-host.exe` to `%LOCALAPPDATA%\TrueAI\Edge\runtime\`.
- Starts the embedded host over stdio JSON-RPC 2.0.
- Discovers all 206 tools dynamically and exposes schema descriptions via `--describe-tool`.

### Development & Integration Mode
Developers and automated integration tests can override execution:
- `--sap-env-path <path>`: Points to local `DEV.env` containing SAP connection parameters.
- `--manifests <dir>`: Points to an external directory of MCP manifest files.
- `--sap-executable <path>`: Overrides the child process binary (e.g., using `fake-mcp.exe`).

---

## 4. Local Configuration & Credential Security

1. **Local Non-Admin User Space**:
   - Edge configuration and state are stored in `%LOCALAPPDATA%\TrueAI\Edge\`.
   - Never writes to `C:\Windows`, `C:\Program Files`, or machine-wide registry.
2. **Customer SAP Configuration Abstraction (`internal/config/sap_config.go`)**:
   - Stores non-secret settings in `%LOCALAPPDATA%\TrueAI\Edge\sap_config.json` with 0600 permissions.
   - `SAPConfig` excludes passwords/tokens from JSON serialization (`json:"-"`).
   - `CredentialStore` interface defines the abstraction point for Windows Credential Manager / DPAPI integration.
3. **Zero Secrets in Logs or CLI Arguments**:
   - Credentials are never passed in command-line arguments, environment variables, or printed in logs.

---

## 5. Verification Protocol & Results

### Clean-Directory Execution (Only `edge.exe`)
Executed in an isolated temporary directory containing ONLY `edge.exe` with Node/npm removed from `PATH`:
```powershell
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP 'edge-clean-test')
Copy-Item .\edge.exe $tmp\edge.exe
$env:PATH = 'C:\Windows\System32;C:\Windows'
Set-Location $tmp.FullName
.\edge.exe --describe-tool GetObjectsList
```

**Results**:
- **Log**: `Using embedded MCP manifest`
- **Log**: `Extracting embedded SAP ADT host`
- **Log**: `MCP handshake succeeded`
- **Log**: `Discovered tools dynamically count: 206`
- **Output**: Full JSON schema for `GetObjectsList`.
- **Zero Warnings**: No warnings or errors regarding missing `mcp\manifests`, missing `node`, or missing `DEV.env`.

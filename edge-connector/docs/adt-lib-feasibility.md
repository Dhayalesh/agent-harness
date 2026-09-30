# @mcp-abap-adt/lib Feasibility & Hosting Analysis

## 1. Executive Summary

This document presents the detailed inspection findings of `@mcp-abap-adt/lib` (version 10.2.0) to determine whether it can serve as the standalone, self-contained SAP ADT MCP engine embedded within the True.ai Edge distribution (`edge.exe`), completely replacing the AGPL-3.0 `@mcp-abap-adt/core` package.

### Key Conclusions
1. **License Cleanliness**: `@mcp-abap-adt/lib` is licensed under **Apache-2.0**. All its direct and transitive dependencies are **MIT, Apache-2.0, or BSD-3-Clause**. There are **zero AGPL or GPL dependencies**.
2. **True Independence from `@mcp-abap-adt/core`**: `@mcp-abap-adt/lib` does **not** import or depend on `@mcp-abap-adt/core`. It was explicitly designed by upstream to be an embeddable library for third-party host applications.
3. **Full Tool Parity**: `@mcp-abap-adt/lib` contains the exact same tool definitions and handlers (~206 tools) that the standalone server exposes.
4. **Runtime Requirement**: The library is written in TypeScript and compiled to JavaScript (CommonJS/ESM). It requires a JavaScript runtime with Node.js standard libraries (`http`, `https`, `crypto`, `events`, `stream`, `fs`). It cannot be executed directly by Go without a JavaScript execution environment.

---

## 2. Public Exports & API Structure

Inspection of `package.json` and `dist/` in `@mcp-abap-adt/lib` reveals the following documented entry points:

| Export Path | Target File | Purpose |
|---|---|---|
| `.` (root) | `dist/index.js` | Exports both `./embeddable/index.js` and `./lib/handlers/index.js`. |
| `./embeddable` | `dist/embeddable/index.js` | Embeddable MCP server classes: `BaseMcpServer`, `EmbeddableMcpServer`, `ConnectionContext`, `IServerConfig`. |
| `./handlers` | `dist/lib/handlers/index.js` | Handler registries and groups: `HandlerExporter`, `CompositeHandlersRegistry`, `BaseHandlerGroup`, concrete handler groups. |
| `./auth` | `dist/lib/auth/index.js` | Authentication: `AuthBrokerFactory`, session stores, broker configs. Supports `--env-path`, `--mcp`, basic auth, JWT. |
| `./config` | `dist/lib/config/index.js` | Configuration parsing and environment management. |
| `./logger` | `dist/lib/handlerLogger.js` | Structured logger adapter for MCP handlers. |
| `./utils` | `dist/lib/utils.js` | ADT URI manipulation, XML serialization, and response normalization. |

---

## 3. How the MCP Server & Tools are Constructed

### A. Server Construction (`EmbeddableMcpServer` & `BaseMcpServer`)
`BaseMcpServer` extends `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.

```typescript
import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Construct embeddable server with connection and registry
const server = new EmbeddableMcpServer({
  connection: abapConnection,
  exposition: ['readonly', 'high'],
  systemType: 'onprem', // or 'cloud'
});

// Connect to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

### B. Tool Registration (`HandlerExporter`)
`HandlerExporter` creates the registry of tools by instantiating handler groups:
- **`ReadOnlyHandlerGroup`**: `read_abap_class`, `read_program`, `read_function_module`, `read_table`, etc.
- **`HighLevelHandlerGroup`**: `GetObjectsList`, `CreateClass`, `UpdateClass`, etc.
- **`LowLevelHandlerGroup`**: Granular ADT endpoints.
- **`SystemHandlerGroup`**: System information, ping, session status.
- **`SearchHandlerGroup`**: Object search and repository discovery.

For every handler entry, `BaseMcpServer.registerHandlers()` invokes:
```typescript
this.tool(entry.name, entry.description, entry.parametersSchema, async (args) => {
  const connection = await this.getConnection();
  return entry.handler(connection, args);
});
```
This binds each tool to the MCP protocol with its Zod input schema, automatically injecting the authenticated SAP connection at runtime.

---

## 4. SAP Connection Construction

`@mcp-abap-adt/lib` provides connection factories in `@mcp-abap-adt/connection` and authentication brokers via `AuthBrokerFactory`:

1. **Environment File Mode (`--env-path=<path>`)**:
   `AuthBrokerFactory.createBrokerWithEnvFileStore(envPath)` loads SAP parameters (`SAP_URL`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWORD`, `SAP_AUTH_TYPE`) directly into an in-memory session store without modifying the original file.
2. **Destination Mode (`--mcp=<destination>`)**:
   Loads the service key JSON from `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\<destination>.json`.
3. **Direct Connection**:
   A host can instantiate `DirectAbapConnection` with explicit credentials and inject it directly into `EmbeddableMcpServer`.

Edge preserves the local configuration model by passing `--env-path=<local DEV.env>` and `--system-type=onprem`.

---

## 5. Dependency & Licensing Analysis

Every dependency in `@mcp-abap-adt/lib`'s dependency tree was inspected:

| Package | Version | License | Copyleft Risk |
|---|---|---|---|
| `@mcp-abap-adt/lib` | 10.2.0 | **Apache-2.0** | None |
| `@mcp-abap-adt/adt-clients` | 10.1.0 | **MIT** | None |
| `@mcp-abap-adt/auth-broker` | 1.0.8 | **MIT** | None |
| `@mcp-abap-adt/auth-providers` | 1.2.0 | **MIT** | None |
| `@mcp-abap-adt/auth-stores` | 1.0.4 | **MIT** | None |
| `@mcp-abap-adt/connection` | 1.10.2 | **MIT** | None |
| `@mcp-abap-adt/header-validator` | 0.1.8 | **MIT** | None |
| `@mcp-abap-adt/interfaces` | 13.1.0 | **MIT** | None |
| `@mcp-abap-adt/logger` | 0.1.4 | **MIT** | None |
| `@mcp-abap-adt/sap-rfc-lite` | 0.1.0 | **Apache-2.0** | None |
| `@modelcontextprotocol/sdk` | 1.29.0 | **MIT** | None |
| `axios` | 1.18.1 | **MIT** | None |
| `diff` | 5.2.2 | **BSD-3-Clause** | None |
| `fast-xml-parser` | 5.9.3 | **MIT** | None |
| `js-yaml` | 4.3.0 | **MIT** | None |
| `pino` / `pino-pretty` | 10.1.0 / 13.1.3 | **MIT** | None |
| `xml-js` | 1.6.11 | **MIT** | None |
| `zod` | 4.3.6 | **MIT** | None |

**Conclusion**: The dependency tree is **100% free of GPL/AGPL copyleft restrictions**.

---

## 6. Hosting Evaluation & The Single-Executable Question

### The Fundamental Constraint
`@mcp-abap-adt/lib` is pure JavaScript/TypeScript. It cannot run directly as bare-metal machine code; it requires a JavaScript engine providing Node.js standard libraries (`http`, `https`, `crypto`, `events`, `stream`).

### Evaluation of Options

#### Option A: Native Go Rewrite
- **Feasibility**: Not feasible.
- **Reason**: Requires rewriting ~206 SAP ADT tools, XML serializers, diff engines, and auth flows in Go. Violates constraint "Do not rewrite the ADT MCP".

#### Option B: In-Memory Embedded JS Engine in Go (e.g. Goja, QuickJS)
- **Feasibility**: Not feasible.
- **Reason**: Goja and QuickJS implement ECMAScript language specifications but lack the Node.js runtime ecosystem (`node:https` with keep-alive agents, TLS sockets, crypto ciphers, and npm dependency support). `@mcp-abap-adt/lib` fails immediately when imported into bare JS engines.

#### Option C: Self-Contained Native MCP Binary (Node SEA / Bundling)
- **Feasibility**: **High (Recommended)**.
- **Mechanism**:
  1. Create a minimal host script `host.js` that imports `@mcp-abap-adt/lib` and `@modelcontextprotocol/sdk/server/stdio.js`, connects `EmbeddableMcpServer` to stdio, and parses `--env-path` and `--system-type`.
  2. Bundle `host.js` and its dependencies using `esbuild` into a single standalone JavaScript file.
  3. Compile this bundle into a standalone Windows executable (`sap-adt-host.exe`) using Node.js Single Executable Application (SEA) or a supported bundling pipeline.
  4. Embed `sap-adt-host.exe` into `edge.exe` via Go's `//go:embed`.
- **Customer Experience**: The customer receives only `edge.exe`. Node/npm are not installed on the customer's machine.
- **Licensing**: Because this host is built strictly from `@mcp-abap-adt/lib` (Apache-2.0) and `@modelcontextprotocol/sdk` (MIT), it contains **zero AGPL-3.0 code**.


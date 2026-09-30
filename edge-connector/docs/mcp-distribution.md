# MCP Distribution & Licensing Analysis

## 1. Executive Summary

This document evaluates the legal, licensing, and technical implications of distributing the external SAP ABAP ADT Model Context Protocol (MCP) server as part of True.ai Edge Connector (`edge.exe`).

The current upstream project [`fr0ster/mcp-abap-adt`](https://github.com/fr0ster/mcp-abap-adt) is divided into two distinct packages with deliberately different licenses:

| Package | Upstream Version | License | Role & Scope |
|---|---|---|---|
| **`@mcp-abap-adt/lib`** | 10.2.0 | **Apache-2.0** | Core ADT tool handlers, ABAP types, XML parsing, embeddable server library. No standalone transport or CLI launcher. |
| **`@mcp-abap-adt/core`** | 10.0.1 | **AGPL-3.0-only** | Standalone server implementation providing stdio, SSE, and streamable HTTP transports, process launcher (`bin/mcp-abap-adt.js`), and the `mcp-abap-adt` CLI. |

> [!CAUTION]
> **Licensing Blocker**: `@mcp-abap-adt/core` is licensed strictly under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**. It must **NOT** be silently bundled, embedded, or redistributed within the proprietary commercial True.ai Edge binary without formal legal review and approval.

---

## 2. Technical Feasibility Analysis

### Current Runtime Reality
An investigation of the installed `@mcp-abap-adt/core` package confirms:
1. **No Standalone Executable**: Upstream does not produce, distribute, or support a standalone Windows `.exe` or native binary.
2. **Pure Node.js Runtime**: The executable invoked on Windows (`mcp-abap-adt`) is an npm-generated batch script (`mcp-abap-adt.cmd`) that invokes Node.js:
   ```cmd
   node "%~dp0\node_modules\@mcp-abap-adt\core\bin\mcp-abap-adt.js" %*
   ```
3. **Runtime Engine Requirement**: `mcp-abap-adt.js` specifies `"engines": { "node": ">=22.0.0" }`. It relies on dynamic execution via Node.js, `dotenv`, `express`, `@modelcontextprotocol/sdk`, and 15+ sub-dependencies. It cannot run without a Node.js engine present on the system.
4. **Feasibility of Direct Embedding**: Because no native binary artifact exists in the package, embedding `@mcp-abap-adt/core` into `edge.exe` directly via Go's `//go:embed` would require either:
   - Bundling an entire Node.js runtime environment (e.g. Node SEA, pkg, or a complete embedded Node.js runtime), or
   - Compiling a separate native executable artifact from source.

Both technical options are directly bound by the licensing requirements described below.

---

## 3. Redistribution & Licensing Requirements

### The Dual-License Architecture of Upstream
Upstream explicitly designed this split:
> *"The project ships as two packages, because the two usage patterns want different licences. Embedding the tools in a network service should not drag in the obligations of a server that service never runs."* (README.md)

### AGPL-3.0-only Implications (`@mcp-abap-adt/core`)
`@mcp-abap-adt/core` contains the actual stdio server launcher used by `mcp-abap-adt`. Distributing it imposes strict copyleft requirements:
1. **Strong Copyleft**: Redistributing AGPL-3.0 software in binary form (including embedding it within an `.exe` or bundling it alongside an application) requires making the Complete Corresponding Source Code available under the AGPL-3.0 license.
2. **Derivative Works & Aggregation**: If True.ai Edge embeds `@mcp-abap-adt/core` into `edge.exe` to provide a single-executable customer experience, legal analysis must determine whether `edge.exe` constitutes a single combined work under copyright law. If so, AGPL-3.0 could require licensing the entire `edge.exe` (including True.ai proprietary router, policies, and process management) under AGPL-3.0.
3. **Network Interaction Clause (Section 13)**: AGPL-3.0 explicitly extends source-disclosure obligations to users interacting with the software across a computer network.
4. **No Commercial Exception**: Upstream does not offer a public commercial dual-license exception for `@mcp-abap-adt/core`.

### Apache-2.0 Possibility (`@mcp-abap-adt/lib`)
The underlying library `@mcp-abap-adt/lib` is licensed under **Apache-2.0**:
- Apache-2.0 is a permissive license that permits commercial use, modification, and redistribution without copyleft source-disclosure requirements on proprietary parent software.
- However, `@mcp-abap-adt/lib` does **not** include the standalone stdio server or CLI launcher. To use `@mcp-abap-adt/lib` under Apache-2.0, True.ai would need to implement an independent host or transport adapter that imports `@mcp-abap-adt/lib` without touching `@mcp-abap-adt/core`.

---

## 4. Commercial Review & Approval Checklist

Before any single-executable customer distribution containing or wrapping the SAP ADT MCP can be shipped commercially, the following steps must be completed:

1. **Corporate Legal Review**:
   - Legal counsel must formally review the AGPL-3.0 vs. Apache-2.0 licensing boundary.
   - Legal counsel must determine whether packaging `@mcp-abap-adt/core` via Node Single Executable Applications (SEA), Electron, pkg, or Go binary embedding constitutes a derivative work or mere distribution aggregation.
2. **Upstream Commercial Licensing Inquiry**:
   - Inquire with upstream author (Oleksii Kyslytsia) regarding commercial licensing terms for `@mcp-abap-adt/core` to permit proprietary bundling without AGPL-3.0 copyleft obligations.
3. **Alternative Architectural Options**:
   - **Option A (Current Safe Boundary)**: Treat `mcp-abap-adt` strictly as an operator-supplied external process. Edge provides process supervision and policy routing; customer or operator installs/provides the MCP binary. Zero licensing liability for True.ai.
   - **Option B (Separate Standalone Artifact)**: Build an upstream-approved standalone executable from `@mcp-abap-adt/core` published under its own AGPL-3.0 release, distributed as a separate downloadable sibling binary (never embedded in `edge.exe`).
   - **Option C (Apache-2.0 Compliant Host)**: Implement an independent transport adapter hosting `@mcp-abap-adt/lib` directly under Apache-2.0, completely avoiding the AGPL-3.0 `@mcp-abap-adt/core` package.
4. **Sign-Off Required**:
   - Product Management approval.
   - Legal & Compliance sign-off.
   - Security team verification of non-admin runtime execution.


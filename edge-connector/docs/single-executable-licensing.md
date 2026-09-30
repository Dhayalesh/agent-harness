# Single-Executable Licensing & Compliance Reference

## 1. Overview

This document provides a factual inventory of the software licenses, copyright notices, and compliance obligations associated with embedding `@mcp-abap-adt/lib` into True.ai Edge Connector (`edge.exe`).

> [!NOTE]
> This document records technical findings based on `package.json` and license files present in the upstream distribution. It does not constitute legal counsel and should be reviewed by corporate compliance before final commercial distribution.

---

## 2. Core Package License: `@mcp-abap-adt/lib`

- **Name**: `@mcp-abap-adt/lib`
- **Version**: 10.2.0
- **Author**: Oleksii Kyslytsia
- **License**: **Apache License, Version 2.0 (Apache-2.0)**
- **Permitted Uses**: Commercial use, modification, distribution, sublicense, private use.
- **Key Obligations**:
  - Reproduce the copyright notice, license text, and disclaimer in distributions.
  - Retain the `NOTICE` file if one exists in the source distribution.
  - State significant changes made to the files (if modified).
  - Patent grant: Explicit grant of patent rights from contributors.
- **Copyleft Restrictions**: **None**. Apache-2.0 does **not** require disclosing proprietary source code of parent or calling applications (unlike AGPL-3.0).

---

## 3. Direct & Transitive Dependencies

The dependency graph of `@mcp-abap-adt/lib` was audited:

| Component | License | Copyleft Obligations |
|---|---|---|
| `@mcp-abap-adt/adt-clients` | MIT | None (permissive) |
| `@mcp-abap-adt/auth-broker` | MIT | None (permissive) |
| `@mcp-abap-adt/auth-providers` | MIT | None (permissive) |
| `@mcp-abap-adt/auth-stores` | MIT | None (permissive) |
| `@mcp-abap-adt/connection` | MIT | None (permissive) |
| `@mcp-abap-adt/header-validator` | MIT | None (permissive) |
| `@mcp-abap-adt/interfaces` | MIT | None (permissive) |
| `@mcp-abap-adt/logger` | MIT | None (permissive) |
| `@mcp-abap-adt/sap-rfc-lite` | Apache-2.0 | None (permissive) |
| `@modelcontextprotocol/sdk` | MIT | None (permissive) |
| `axios` | MIT | None (permissive) |
| `diff` | BSD-3-Clause | None (permissive) |
| `fast-xml-parser` | MIT | None (permissive) |
| `js-yaml` | MIT | None (permissive) |
| `pino` | MIT | None (permissive) |
| `pino-pretty` | MIT | None (permissive) |
| `xml-js` | MIT | None (permissive) |
| `zod` | MIT | None (permissive) |

### Copyleft Finding
**Zero transitive dependencies introduce copyleft (GPL, AGPL, LGPL) obligations.** All packages in the `@mcp-abap-adt/lib` tree use permissive open-source licenses (MIT, Apache-2.0, BSD).

---

## 4. Packaging Runtime License (Node.js & SEA)

If Node.js Single Executable Application (SEA) or a bundled Node.js engine is used to host the JavaScript bundle as a standalone binary:
- **Node.js License**: MIT License (with components under BSD-2-Clause, BSD-3-Clause, ISC, and zlib).
- **V8 Engine**: BSD-3-Clause.
- **OpenSSL**: OpenSSL License / Apache-2.0.
- **Compliance Requirement**: The binary distribution must include the Node.js license disclaimer in its third-party notices document.

---

## 5. Required Notices for Shipping

To commercially distribute `edge.exe` containing an embedded `@mcp-abap-adt/lib` host, True.ai must include an accompanying `THIRD_PARTY_LICENSES.txt` or display notices via a CLI command (e.g. `edge.exe --licenses`):

1. **Apache-2.0 License Text**: Full text of Apache-2.0.
2. **`@mcp-abap-adt/lib` Notice**:
   ```text
   mcp-abap-adt
   Copyright 2024 Oleksii Kyslytsia and contributors
   Licensed under the Apache License, Version 2.0.
   ```
3. **MIT Notices**: Standard MIT copyright disclaimers for `@modelcontextprotocol/sdk`, `axios`, `zod`, `pino`, `fast-xml-parser`, etc.
4. **BSD-3-Clause Notices**: Copyright notices for `diff` and V8 components.


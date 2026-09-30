package assets

import (
	_ "embed"
)

// EmbeddedHostBinary contains the standalone SAP ADT MCP host executable (sap-adt-host.exe)
// built strictly from @mcp-abap-adt/lib (Apache-2.0) and @modelcontextprotocol/sdk (MIT).
//
//go:embed mcp/sap-adt-host.exe
var EmbeddedHostBinary []byte

// EmbeddedDefaultManifest contains the default sap-adt MCP manifest embedded into the binary.
// Used when no external manifest directory is supplied.
//
//go:embed manifests/sap-adt.yaml
var EmbeddedDefaultManifest []byte

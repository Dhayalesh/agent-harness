import { AgentHarnessError } from '../core/errors.js';
import type { McpServerAuth, McpServerWire } from './mcp-server-definitions.js';

/**
 * What the runtime honours *today*.
 *
 * The `mcp_servers` schema deliberately stores a wider shape than the runtime
 * can act on, so that records survive the transport work without a migration. To
 * keep the difference from becoming a silent drop, every create and update is
 * validated against this table and rejected when it names something the runtime
 * would ignore.
 *
 * When a further transport lands, this file is the only thing that changes.
 */
export const MCP_RUNTIME_SUPPORT = {
  /**
   * `sse` has no client. `McpConnection` exposes `connectStdio` and
   * `connectHttp` only (`src/mcp/client.ts`), and `SSEClientTransport` is never
   * imported, so a stored `sse` record could not be connected.
   */
  transports: ['stdio', 'http'] as const,
  /**
   * All three auth kinds are expressible, because an HTTP transport carries
   * whatever headers the registry builds: `bearer` sets `Authorization`,
   * `header` sets the record's `headerName`, `none` sets neither.
   */
  authKinds: ['bearer', 'header', 'none'] as const,
  /**
   * `stderr` and `cwd` reach `StdioServerParameters`, and `sessionId` reaches
   * `StreamableHTTPClientTransportOptions`. The others have no seam:
   * - `reconnect`: `McpConnection` never re-dials. `close()` is terminal and
   *   nothing watches for a dropped transport (`src/mcp/client.ts`).
   * - `protocolVersion`: the SDK negotiates the version during `initialize` and
   *   takes no override from the client side.
   */
  wireFields: ['stderr', 'cwd', 'sessionId'] as const,
  /**
   * Every stored capability is acted on: the three surface flags decide which
   * of `tools()`, `listResources()`, and `listPrompts()` the registry calls,
   * `elicitation` decides whether a handler is registered and the capability
   * advertised, and the two budgets become the `initialize` and per-request
   * timeouts.
   */
  capabilitiesHonoured: [
    'tools',
    'resources',
    'prompts',
    'elicitation',
    'connectTimeoutMs',
    'requestTimeoutMs',
  ] as const,
} as const;

/**
 * Headers the record cannot set, because the transport or the auth kind owns
 * them. Rejecting them at write time keeps one source for each: a value stored
 * here would be overwritten on every request and read as configuration that is
 * not in effect.
 */
export const RESERVED_HEADER_NAMES = [
  'Authorization',
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
] as const;

export type SupportedMcpTransport = (typeof MCP_RUNTIME_SUPPORT.transports)[number];
export type SupportedMcpAuthKind = (typeof MCP_RUNTIME_SUPPORT.authKinds)[number];
export type SupportedMcpWireField = (typeof MCP_RUNTIME_SUPPORT.wireFields)[number];

const WIRE_FIELD_REASONS: Readonly<Record<keyof McpServerWire, string>> = {
  stderr: '',
  cwd: '',
  sessionId: '',
  reconnect: 'McpConnection never re-dials a dropped transport (src/mcp/client.ts)',
  protocolVersion:
    'the protocol version is negotiated during initialize and takes no client-side override',
};

/** Which transport each honoured wire field belongs to. */
const WIRE_FIELD_TRANSPORTS: Readonly<Record<SupportedMcpWireField, SupportedMcpTransport>> = {
  stderr: 'stdio',
  cwd: 'stdio',
  sessionId: 'http',
};

/** The subset of a record the support gate inspects. */
export type McpRuntimeSupportCheckInput = {
  transport: string;
  auth: McpServerAuth;
  wire?: McpServerWire | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
};

/**
 * Rejects any stored shape the runtime would ignore. Called on every create and
 * update, and again at resolution as defence in depth.
 */
export function assertMcpRuntimeSupport(record: McpRuntimeSupportCheckInput): void {
  assertSupportedTransport(record.transport);
  assertSupportedAuth(record.auth);
  assertSupportedWire(record.wire, record.transport);
  assertSupportedHeaders(record.headers, record.auth);
}

function assertSupportedTransport(transport: string): void {
  if (!(MCP_RUNTIME_SUPPORT.transports as readonly string[]).includes(transport)) {
    throw new AgentHarnessError(
      `Unsupported field 'transport': '${transport}' has no client in this runtime. ` +
        `Supported: ${MCP_RUNTIME_SUPPORT.transports.join(', ')}.`,
      'UNSUPPORTED_MCP_TRANSPORT',
    );
  }
}

function assertSupportedAuth(auth: McpServerAuth): void {
  if ((MCP_RUNTIME_SUPPORT.authKinds as readonly string[]).includes(auth.kind)) return;
  throw new AgentHarnessError(
    `Unsupported field 'auth.kind': '${auth.kind}' has no header the registry knows how to ` +
      `build. Supported: ${MCP_RUNTIME_SUPPORT.authKinds.join(', ')}.`,
    'UNSUPPORTED_MCP_AUTH_KIND',
  );
}

function assertSupportedWire(wire: McpServerWire | undefined, transport: string): void {
  if (!wire) return;
  for (const field of Object.keys(wire) as Array<keyof McpServerWire>) {
    if (wire[field] === undefined) continue;
    if (!(MCP_RUNTIME_SUPPORT.wireFields as readonly string[]).includes(field)) {
      throw new AgentHarnessError(
        `Unsupported field 'wire.${field}': ${WIRE_FIELD_REASONS[field]}. ` +
          `Supported: ${MCP_RUNTIME_SUPPORT.wireFields.map((name) => `wire.${name}`).join(', ')}.`,
        'UNSUPPORTED_MCP_WIRE_FIELD',
      );
    }
    const owner = WIRE_FIELD_TRANSPORTS[field as SupportedMcpWireField];
    if (owner !== transport) {
      throw new AgentHarnessError(
        `Unsupported field 'wire.${field}': it reaches the ${owner} transport only, ` +
          `and this record uses ${transport}, so the value would never be read. ` +
          'Omit it, or change the transport.',
        'UNSUPPORTED_MCP_WIRE_FIELD',
      );
    }
  }
}

function assertSupportedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  auth: McpServerAuth,
): void {
  const authHeader = auth.kind === 'header' ? auth.headerName : undefined;
  for (const name of Object.keys(headers ?? {})) {
    if (matches(name, RESERVED_HEADER_NAMES)) {
      throw new AgentHarnessError(
        `Unsupported field 'headers.${name}': the transport and auth.kind own ` +
          `${RESERVED_HEADER_NAMES.join(', ')}; a stored value would be overwritten on every ` +
          "request. Use auth.kind 'bearer' with apiKey to send a credential.",
        'UNSUPPORTED_MCP_HEADER',
      );
    }
    if (authHeader !== undefined && matches(name, [authHeader])) {
      throw new AgentHarnessError(
        `Unsupported field 'headers.${name}': auth.headerName already sets it from apiKey, ` +
          'so the stored value would be overwritten. Rename one of the two.',
        'UNSUPPORTED_MCP_HEADER',
      );
    }
  }
}

/** Header names are case-insensitive, so the comparison has to be too. */
function matches(name: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

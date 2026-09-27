import { z } from 'zod';

/**
 * The timestamp helper is shared with `model_providers` rather than duplicated:
 * both collections stamp ISO-8601 strings read from the same clock.
 */
export { nowIso } from './model-provider-definitions.js';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/**
 * The credential, stored inline on the record.
 *
 * Whoever can write this collection can set `apiKey`, `url`, `command`, and
 * `env` together, and can therefore send this credential to an endpoint of their
 * choosing or hand it to a process of their choosing. Nothing outside
 * `mcp_servers` constrains that, so treat write access to it as equivalent to
 * holding the key and to local code execution.
 */
const apiKeyValue = z.string().min(1).max(8192);

export const mcpServerAuthSchema = z
  .object({
    kind: z.enum(['bearer', 'header', 'none']),
    headerName: z.string().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'header' && !value.headerName) {
      context.addIssue({ code: 'custom', message: 'header auth requires headerName' });
    }
  });

export const mcpServerCapabilitiesSchema = z
  .object({
    tools: z.boolean(),
    resources: z.boolean(),
    prompts: z.boolean(),
    elicitation: z.boolean(),
    /** Budget for the `initialize` handshake. */
    connectTimeoutMs: z.number().int().positive().max(600_000),
    /** Budget for every request after it, including each tool call. */
    requestTimeoutMs: z.number().int().positive().max(600_000),
  })
  .strict()
  .superRefine((value, context) => {
    // A server that exposes none of the three surfaces has nothing the runtime
    // could read from it, so connecting it would spawn a process or open a
    // session for no reachable capability.
    if (!value.tools && !value.resources && !value.prompts) {
      context.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'at least one of tools, resources, prompts must be enabled',
      });
    }
  });

export const mcpServerWireSchema = z
  .object({
    stderr: z.enum(['pipe', 'ignore', 'inherit', 'overlapped']).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    sessionId: z.string().min(1).max(300).optional(),
    reconnect: z.boolean().optional(),
    protocolVersion: z.string().min(1).max(50).optional(),
  })
  .strict();

/**
 * No id field: identity is MongoDB's own `_id`, which it assigns and indexes
 * uniquely on every document. Carrying a second application-level id would store
 * and index the same identity twice, so the stored shape is these fields plus the
 * `_id` the driver attaches (`StoredMcpServerRecord`).
 */
const mcpServerShape = {
  name: identifier,
  transport: z.enum(['stdio', 'http', 'sse', 'edge']),
  mcpId: identifier.optional(),
  command: z.string().min(1).max(1000).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().optional(),
  apiKey: apiKeyValue.optional(),
  auth: mcpServerAuthSchema,
  capabilities: mcpServerCapabilitiesSchema,
  wire: mcpServerWireSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  /**
   * Whether a run picks this record up. Unlike a model provider there is no
   * single default: MCP servers compose, so every enabled record with this flag
   * is connected together. Nothing outside the collection can add to or narrow
   * that set, so this field is the only switch.
   */
  autoConnect: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: identifier,
};

type CrossFieldShape = {
  transport: 'stdio' | 'http' | 'sse' | 'edge';
  mcpId?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  auth: { kind: 'bearer' | 'header' | 'none' };
};

/**
 * The transport decides which half of the record is meaningful. Storing the
 * other half would leave a record that reads as configured while the field is
 * never passed to a transport, so the unused half is rejected instead of
 * ignored.
 */
function refineCrossFields(value: CrossFieldShape, context: z.RefinementCtx): void {
  if (value.transport === 'edge') {
    if (!value.mcpId) {
      context.addIssue({
        code: 'custom',
        path: ['mcpId'],
        message: 'edge MCP server requires mcpId',
      });
    }
    if (value.url && !value.url.startsWith('wss://')) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'edge MCP server requires a wss URL',
      });
    }
    if (value.auth.kind !== 'none' || value.apiKey || value.headers) {
      context.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'edge MCP server uses runtime EDGE_USER_EMAIL, not record credentials or headers',
      });
    }
  } else if (value.mcpId !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['mcpId'],
      message: 'mcpId is only used by edge MCP servers',
    });
  }
  if (value.transport === 'stdio') {
    if (!value.command) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'stdio MCP server requires command',
      });
    }
    if (value.url) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'url must be omitted for a stdio MCP server',
      });
    }
    if (value.headers) {
      context.addIssue({
        code: 'custom',
        path: ['headers'],
        message:
          'headers must be omitted for a stdio MCP server: there is no HTTP request to carry them',
      });
    }
    if (value.auth.kind !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['auth', 'kind'],
        message: `auth.kind must be none for a stdio MCP server, received '${value.auth.kind}': a pipe carries no request to authenticate. Pass the credential through env instead.`,
      });
    }
  } else {
    if (!value.url) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: `${value.transport} MCP server requires url`,
      });
    }
    for (const field of ['command', 'args', 'env'] as const) {
      if (value[field] === undefined) continue;
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} must be omitted for a ${value.transport} MCP server: no process is spawned`,
      });
    }
  }
  if (value.auth.kind !== 'none' && !value.apiKey) {
    context.addIssue({
      code: 'custom',
      path: ['apiKey'],
      message: `${value.auth.kind} auth requires apiKey`,
    });
  }
  if (value.auth.kind === 'none' && value.apiKey) {
    context.addIssue({
      code: 'custom',
      path: ['apiKey'],
      message: 'apiKey must be omitted when auth.kind is none',
    });
  }
}

const mcpServerRecordObject = z.object(mcpServerShape).strict();

export const mcpServerRecordSchema = mcpServerRecordObject.superRefine(refineCrossFields);

/**
 * Create payload. Identity, timestamps, and provenance are deliberately absent:
 * the store assigns them, never request input.
 */
export const mcpServerInputSchema = mcpServerRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .extend({ enabled: z.boolean().default(true) })
  .strict()
  .superRefine(refineCrossFields);

/**
 * Patch shape for `update`. Identity, timestamps, and provenance are not
 * mutable. Cross-field invariants are re-checked on the merged record rather
 * than on the patch, so a partial update cannot bypass them.
 */
export const mcpServerUpdateSchema = mcpServerRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .partial()
  .strict();

export type McpServerRecord = z.infer<typeof mcpServerRecordSchema>;
export type McpServerInput = z.input<typeof mcpServerInputSchema>;
export type McpServerUpdate = z.infer<typeof mcpServerUpdateSchema>;
export type McpServerAuth = z.infer<typeof mcpServerAuthSchema>;
export type McpServerCapabilities = z.infer<typeof mcpServerCapabilitiesSchema>;
export type McpServerWire = z.infer<typeof mcpServerWireSchema>;
export type McpServerTransport = McpServerRecord['transport'];

export function parseMcpServerInput(value: unknown): z.output<typeof mcpServerInputSchema> {
  return mcpServerInputSchema.parse(value);
}

export function parseMcpServerRecord(value: unknown): McpServerRecord {
  return mcpServerRecordSchema.parse(value);
}

export function parseMcpServerUpdate(value: unknown): McpServerUpdate {
  return mcpServerUpdateSchema.parse(value);
}

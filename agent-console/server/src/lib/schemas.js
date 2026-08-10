import { z } from "zod";
import { AVAILABLE_TOOLS, SUPPORTED_MODEL_PROVIDERS } from "../config.js";
import { badRequest } from "./http-error.js";

export const objectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/, "Expected a lowercase 24-character ObjectId");

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "Use letters, digits, dot, dash or underscore",
  );

// A provider's stored name is a display label and references use its ObjectId.
// The runtime payload still needs an identifier, so resolveAgentForInvocation
// normalizes this label immediately before applying the strict record schema.
const resourceDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Control characters are not allowed");

const skillName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, dash or underscore");

const isoTimestamp = z.string().datetime({ offset: true });
const stringMap = z.record(z.string(), z.string());
const nullableStringMapPatch = z
  .union([stringMap, z.literal(""), z.null()])
  .optional();

export const limitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(1_000).default(24),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    maxInputTokens: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

const agentSkillSchema = z
  .object({
    skillId: objectIdString,
    allowedTools: z.array(identifier).max(200).optional(),
  })
  .strict();

const agentShape = {
  name: identifier,
  description: z.string().trim().max(1_000).optional(),
  systemPrompt: z.string().trim().min(1).max(500_000),
  modelProviderId: objectIdString,
  model: z.string().trim().min(1).max(300).optional(),
  tools: z.array(identifier).max(200).default([]),
  skills: z.array(agentSkillSchema).max(100).default([]),
  mcpServerIds: z.array(objectIdString).max(50).default([]),
  limits: limitsSchema.default({ maxTurns: 24 }),
  /**
   * Asks the runtime to answer as an event stream rather than one buffered result.
   * Off by default, and only sent in the payload when it is on, so an agent that
   * never opted in produces the payload it always produced.
   */
  stream: z.boolean().default(false),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().optional(),
};

const refineAgent = (value, context) => {
  unique(value.tools, ["tools"], context);
  unique(value.mcpServerIds, ["mcpServerIds"], context);
  unique(
    value.skills.map((skill) => skill.skillId),
    ["skills"],
    context,
  );
  const offered = new Set(value.tools);
  for (const [index, skill] of value.skills.entries()) {
    for (const tool of skill.allowedTools ?? []) {
      if (!offered.has(tool)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skills", index, "allowedTools"],
          message: "Every allowedTools entry must also appear in agent.tools",
        });
      }
    }
  }
  const unavailable = value.tools.filter((tool) => !AVAILABLE_TOOLS.includes(tool));
  if (unavailable.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tools"],
      message: "This AgentCore deployment does not advertise: " + unavailable.join(", "),
    });
  }
};

export const agentCreateSchema = z.object(agentShape).strict().superRefine(refineAgent);
export const agentUpdateSchema = z
  .object(agentShape)
  .partial()
  .extend({
    description: z.string().trim().max(1_000).nullable().optional(),
    model: z.string().trim().min(1).max(300).nullable().optional(),
    isDefault: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const agentRecordSchema = z
  .object({
    ...agentShape,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    createdBy: identifier,
  })
  .strict()
  .superRefine(refineAgent);

const authSchema = z
  .object({
    kind: z.enum(["bearer", "header", "none"]),
    headerName: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const modelCapabilitiesSchema = z
  .object({
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(10_000_000),
    supportsTools: z.boolean(),
    supportsStreaming: z.boolean(),
    supportsReasoning: z.boolean(),
    reportsCost: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxOutputTokens >= value.contextWindow) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOutputTokens"],
        message: "maxOutputTokens must be smaller than contextWindow",
      });
    }
  });

const modelWireSchema = z
  .object({
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  })
  .strict();

const modelProviderShape = {
  name: resourceDisplayName,
  provider: z.enum(SUPPORTED_MODEL_PROVIDERS),
  model: z.string().trim().min(1).max(300),
  baseURL: z.string().trim().url().optional(),
  apiKey: z.string().min(1).max(8_192).optional(),
  auth: authSchema,
  capabilities: modelCapabilitiesSchema,
  wire: modelWireSchema.optional(),
  headers: stringMap.optional(),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().optional(),
};

const allowedModelHeaders = new Set([
  "HTTP-Referer",
  "X-OpenRouter-Title",
  "X-OpenRouter-Categories",
]);

const refineModelProvider = (value, context) => {
  if (value.provider !== "openrouter" && !value.baseURL) {
    issue(context, ["baseURL"], value.provider + " requires baseURL");
  }
  if (value.baseURL) validatePublicEndpoint(value.baseURL, ["baseURL"], context);
  if (value.auth.kind !== "bearer") {
    issue(context, ["auth", "kind"], "The deployed harness supports bearer model auth only");
  }
  if (!value.apiKey) {
    issue(context, ["apiKey"], "The model provider requires apiKey");
  }
  if (value.auth.headerName) {
    issue(context, ["auth", "headerName"], "headerName is unsupported for bearer model auth");
  }
  if (value.provider === "openrouter" && value.wire?.maxTokensField) {
    issue(context, ["wire", "maxTokensField"], "OpenRouter fixes the max token field");
  }
  for (const name of Object.keys(value.headers ?? {})) {
    if (!allowedModelHeaders.has(name)) {
      issue(context, ["headers", name], "Unsupported model header");
    }
  }
};

export const modelProviderCreateSchema = z
  .object(modelProviderShape)
  .strict()
  .superRefine(refineModelProvider);
export const modelProviderUpdateSchema = z
  .object(modelProviderShape)
  .partial()
  .extend({
    baseURL: z.union([z.string().trim().url(), z.literal(""), z.null()]).optional(),
    apiKey: z.union([z.string().max(8_192), z.null()]).optional(),
    headers: nullableStringMapPatch,
    wire: z.union([modelWireSchema, z.null()]).optional(),
    isDefault: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const modelProviderRecordSchema = z
  .object({
    ...modelProviderShape,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    createdBy: identifier,
  })
  .strict()
  .superRefine(refineModelProvider);

const mcpCapabilitiesSchema = z
  .object({
    tools: z.boolean(),
    resources: z.boolean(),
    prompts: z.boolean(),
    elicitation: z.boolean(),
    connectTimeoutMs: z.number().int().positive().max(600_000),
    requestTimeoutMs: z.number().int().positive().max(600_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.tools && !value.resources && !value.prompts) {
      issue(context, ["tools"], "At least one MCP surface must be enabled");
    }
  });

const mcpWireSchema = z
  .object({
    stderr: z.enum(["pipe", "ignore", "inherit", "overlapped"]).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    sessionId: z.string().min(1).max(300).optional(),
  })
  .strict();

const mcpServerShape = {
  name: identifier,
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().min(1).max(1_000).optional(),
  args: z.array(z.string().max(4_096)).max(100).optional(),
  env: stringMap.optional(),
  url: z.string().trim().url().optional(),
  apiKey: z.string().min(1).max(8_192).optional(),
  auth: authSchema,
  capabilities: mcpCapabilitiesSchema,
  wire: mcpWireSchema.optional(),
  headers: stringMap.optional(),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().optional(),
};

const reservedMcpHeaders = new Set([
  "authorization",
  "mcp-session-id",
  "mcp-protocol-version",
]);

const refineMcpServer = (value, context) => {
  if (value.url) validatePublicEndpoint(value.url, ["url"], context);
  if (value.transport === "stdio") {
    if (!value.command) issue(context, ["command"], "stdio transport requires command");
    if (value.url) issue(context, ["url"], "stdio transport forbids url");
    if (value.headers) issue(context, ["headers"], "stdio transport forbids headers");
    if (value.auth.kind !== "none") {
      issue(context, ["auth", "kind"], "stdio transport requires auth.kind none");
    }
    if (value.wire?.sessionId) {
      issue(context, ["wire", "sessionId"], "sessionId belongs to HTTP transport");
    }
  } else {
    if (!value.url) issue(context, ["url"], "http transport requires url");
    for (const field of ["command", "args", "env"]) {
      if (value[field] !== undefined) {
        issue(context, [field], field + " must be omitted for HTTP transport");
      }
    }
    if (value.wire?.stderr || value.wire?.cwd) {
      issue(context, ["wire"], "stderr and cwd belong to stdio transport");
    }
  }
  if (value.auth.kind === "header" && !value.auth.headerName) {
    issue(context, ["auth", "headerName"], "header auth requires headerName");
  }
  if (value.auth.kind !== "none" && !value.apiKey) {
    issue(context, ["apiKey"], value.auth.kind + " auth requires apiKey");
  }
  if (value.auth.kind === "none" && value.apiKey) {
    issue(context, ["apiKey"], "apiKey must be omitted for auth.kind none");
  }
  for (const name of Object.keys(value.headers ?? {})) {
    const lower = name.toLowerCase();
    if (reservedMcpHeaders.has(lower)) {
      issue(context, ["headers", name], "Header is owned by MCP transport/auth");
    }
    if (
      value.auth.kind === "header" &&
      lower === value.auth.headerName?.toLowerCase()
    ) {
      issue(context, ["headers", name], "Header duplicates auth.headerName");
    }
  }
};

export const mcpServerCreateSchema = z
  .object(mcpServerShape)
  .strict()
  .superRefine(refineMcpServer);
export const mcpServerUpdateSchema = z
  .object(mcpServerShape)
  .partial()
  .extend({
    command: z.union([z.string().trim().min(1).max(1_000), z.null()]).optional(),
    args: z.union([z.array(z.string().max(4_096)).max(100), z.null()]).optional(),
    env: nullableStringMapPatch,
    url: z.union([z.string().trim().url(), z.literal(""), z.null()]).optional(),
    apiKey: z.union([z.string().max(8_192), z.null()]).optional(),
    wire: z.union([mcpWireSchema, z.null()]).optional(),
    headers: nullableStringMapPatch,
    autoConnect: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const mcpServerRecordSchema = z
  .object({
    ...mcpServerShape,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    createdBy: identifier,
  })
  .strict()
  .superRefine(refineMcpServer);

const skillShape = {
  name: skillName,
  uri: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .regex(/^(s3:\/\/|https:\/\/)[^\s]+$/, "Expected an S3 URI"),
  enabled: z.boolean().default(true),
};

export const skillCreateSchema = z.object(skillShape).strict();
export const skillUpdateSchema = z
  .object(skillShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const skillRecordSchema = z
  .object({
    ...skillShape,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    createdBy: identifier,
  })
  .strict();

export const invokeSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2_000_000),
    runtimeSessionId: z
      .string()
      .trim()
      .min(33, "AgentCore requires at least 33 characters")
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .optional(),
    permissionMode: z.enum(["default", "plan", "bypass", "deny"]).optional(),
    includeEvents: z.boolean().default(false),
  })
  .strict();

export const chatCreateSchema = z
  .object({
    agentId: objectIdString,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const chatUpdateSchema = z
  .object({ title: z.string().trim().min(1).max(200) })
  .strict();
export const chatMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(2_000_000),
    permissionMode: z.enum(["default", "plan", "bypass", "deny"]).optional(),
    includeEvents: z.boolean().default(false),
  })
  .strict();

export const runtimeResultSchema = z
  .object({
    status: z.enum(["success", "error"]),
    sessionId: z.string().min(1).max(200),
    agentName: z.string().min(1).max(100),
    output: z.string(),
    messages: z.array(z.unknown()),
    workingDirectory: z.string(),
    stopReason: z.string().optional(),
    turns: z.number().int().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        estimatedCostUsd: z.number().nonnegative().optional(),
      })
      .passthrough(),
    tools: z.array(
      z
        .object({
          name: z.string(),
          calls: z.number().int().nonnegative(),
          errors: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    events: z.array(z.unknown()).optional(),
    durationMs: z.number().nonnegative(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        recoverable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw badRequest(
    "Validation failed",
    result.error.issues.map((entry) => ({
      field: entry.path.join(".") || "(root)",
      message: entry.message,
    })),
  );
}

export function parseRecordOrThrow(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw badRequest(
    label + " is incompatible with the deployed harness",
    result.error.issues.map((entry) => ({
      field: entry.path.join(".") || "(root)",
      message: entry.message,
    })),
  );
}

function unique(values, path, context) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issue(context, [...path, index], "Duplicate entry");
    }
    seen.add(value);
  }
}

function issue(context, path, message) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function validatePublicEndpoint(value, path, context) {
  let url;
  try {
    url = new URL(value);
  } catch {
    issue(context, path, "Expected a valid URL");
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    issue(context, path, "Endpoint URLs must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    issue(context, path, "Endpoint URLs cannot contain credentials; use the auth fields");
  }
  if (url.search || url.hash) {
    issue(
      context,
      path,
      "Endpoint URLs cannot contain query parameters or fragments; use auth or headers for credentials",
    );
  }
}

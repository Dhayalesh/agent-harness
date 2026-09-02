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

/**
 * `compactionThresholdPercent` replaces what used to be an absolute
 * `maxInputTokens`. The tokens are a property of the model, so they live on the
 * model provider record; the percentage is the only part that is a choice. Capped
 * at 99 because a context that only shrinks once the budget is completely full has
 * already been refused by the provider.
 */
export const limitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(1_000).default(24),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    compactionThresholdPercent: z.number().int().min(1).max(99).optional(),
  })
  .strict();

const unitInterval = z.number().min(0).max(1);
const contextSourceMetadataSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(300),
    type: z.enum([
      "user",
      "conversation",
      "memory",
      "file",
      "web",
      "mcp",
      "database",
      "api",
      "task-state",
      "artifact",
      "application-context",
      "document",
      "structured",
      "vector",
      "semantic",
      "keyword",
      "hybrid",
      "tool",
      "external",
      "derived",
    ]),
    sourceKind: z
      .enum([
        "FILE",
        "WEB",
        "MEMORY",
        "MCP",
        "DATABASE",
        "API",
        "TASK_STATE",
        "ARTIFACT",
        "APPLICATION_CONTEXT",
      ])
      .optional(),
    provider: z.string().trim().min(1).max(300).optional(),
    authority: unitInterval,
    retrievedAt: isoTimestamp.optional(),
    observedAt: isoTimestamp.optional(),
    sourceTimestamp: isoTimestamp.optional(),
    validFrom: isoTimestamp.optional(),
    validUntil: isoTimestamp.optional(),
    version: z.string().max(300).optional(),
    scope: z.array(z.string().max(300)).max(100).optional(),
    uri: z.string().max(4096).optional(),
    contentHash: z.string().max(300).optional(),
    extractionContext: z.string().max(2000).optional(),
    evidenceIdentity: z.string().max(300).optional(),
    policyLabels: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();

export const contextIntelligenceConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    features: z
      .object({
        queryIntelligence: z.boolean().optional(),
        retrieval: z.boolean().optional(),
        memory: z.boolean().optional(),
        chunking: z.boolean().optional(),
        structuredShaping: z.boolean().optional(),
        capabilityNarrowing: z.boolean().optional(),
        observationProcessing: z.boolean().optional(),
        conflictDetection: z.boolean().optional(),
        compression: z.boolean().optional(),
        pruning: z.boolean().optional(),
        offloading: z.boolean().optional(),
        advancedReasoning: z.boolean().optional(),
        boundedFeedback: z.boolean().optional(),
        predictiveContext: z.boolean().optional(),
        observedPerformanceOptimization: z.boolean().optional(),
        evaluationMetrics: z.boolean().optional(),
      })
      .strict()
      .optional(),
    budgets: z
      .object({
        maxInputTokens: z.number().int().positive().max(10000000).optional(),
        outputReservationTokens: z
          .number()
          .int()
          .positive()
          .max(10000000)
          .optional(),
        safetyMarginTokens: z
          .number()
          .int()
          .nonnegative()
          .max(1000000)
          .optional(),
        categoryShares: z
          .object({
            systemInstructions: unitInterval.optional(),
            taskInstructions: unitInterval.optional(),
            userRequest: unitInterval.optional(),
            conversationHistory: unitInterval.optional(),
            memory: unitInterval.optional(),
            retrievalEvidence: unitInterval.optional(),
            toolObservations: unitInterval.optional(),
            toolDefinitions: unitInterval.optional(),
            taskState: unitInterval.optional(),
            safetyPolicy: unitInterval.optional(),
          })
          .strict()
          .optional(),
        maxRetrievalIterations: z.number().int().positive().max(20).optional(),
        maxRetrievalResults: z.number().int().positive().max(1000).optional(),
        maxRetrievalTokens: z
          .number()
          .int()
          .positive()
          .max(10000000)
          .optional(),
        maxRetrievalOperations: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional(),
        maxToolActions: z.number().int().positive().max(1000).optional(),
        maxLoopMilliseconds: z.number().int().positive().max(600000).optional(),
      })
      .strict()
      .optional(),
    retrieval: z
      .object({
        relevanceThreshold: unitInterval.optional(),
        sufficiencyThreshold: unitInterval.optional(),
        freshnessHalfLifeMs: z.number().int().positive().optional(),
        maximumProvidersPerQuery: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional(),
        deduplicationThreshold: unitInterval.optional(),
        rerank: z.boolean().optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        recallLimit: z.number().int().positive().max(1000).optional(),
        admissionThreshold: unitInterval.optional(),
        relevanceThreshold: unitInterval.optional(),
        maximumItems: z.number().int().positive().max(100000).optional(),
        defaultTtlMs: z.number().int().positive().optional(),
        allowedPrivacy: z
          .array(z.enum(["public", "internal", "confidential", "restricted"]))
          .max(4)
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maximumExpansions: z.number().int().nonnegative().max(50).optional(),
        maximumSubqueries: z.number().int().positive().max(100).optional(),
        minimumRewriteLength: z
          .number()
          .int()
          .nonnegative()
          .max(10000)
          .optional(),
        aliases: z.record(z.array(z.string().max(300)).max(50)).optional(),
      })
      .strict()
      .optional(),
    hygiene: z
      .object({
        relevanceThreshold: unitInterval.optional(),
        authorityThreshold: unitInterval.optional(),
        freshnessThreshold: unitInterval.optional(),
        compressionThresholdTokens: z
          .number()
          .int()
          .positive()
          .max(10000000)
          .optional(),
        offloadThresholdChars: z
          .number()
          .int()
          .positive()
          .max(100000000)
          .optional(),
        maximumActiveItems: z.number().int().positive().max(10000).optional(),
      })
      .strict()
      .optional(),
    capability: z
      .object({
        relevanceThreshold: unitInterval.optional(),
        maximumExposed: z.number().int().positive().max(1000).optional(),
        minimumExposed: z.number().int().nonnegative().max(1000).optional(),
        alwaysExpose: z.array(identifier).max(1000).optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        defaultStrategy: z
          .enum([
            "fixed",
            "recursive",
            "document",
            "semantic",
            "llm",
            "agentic",
            "hierarchical",
            "late",
          ])
          .optional(),
        targetTokens: z.number().int().positive().max(1000000).optional(),
        overlapTokens: z.number().int().nonnegative().max(1000000).optional(),
        maximumTokens: z.number().int().positive().max(1000000).optional(),
        semanticThreshold: unitInterval.optional(),
      })
      .strict()
      .optional(),
    reasoning: z
      .object({
        mode: z
          .enum(["auto", "direct", "react", "alternatives", "tree"])
          .optional(),
        examples: z
          .array(
            z
              .object({
                input: z.string().min(1).max(10000),
                output: z.string().min(1).max(20000),
              })
              .strict(),
          )
          .max(20)
          .optional(),
        maximumAlternatives: z.number().int().positive().max(20).optional(),
      })
      .strict()
      .optional(),
    quality: z
      .object({
        conflictPolicy: z.enum(["proceed", "clarify", "abstain"]).optional(),
        unavailablePolicy: z.enum(["abstain", "clarify"]).optional(),
      })
      .strict()
      .optional(),
    p3: z
      .object({
        maximumFeedbackRecords: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional(),
        maximumPerformanceProfiles: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional(),
        minimumComparableSamples: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional(),
        maximumPredictiveHints: z.number().int().positive().max(20).optional(),
        maximumEvaluationOperations: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional(),
        maximumSourceReferencesPerFeedback: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional(),
      })
      .strict()
      .optional(),
    sourceAuthority: z.record(unitInterval).optional(),
    sourceMetadata: z.array(contextSourceMetadataSchema).max(1000).optional(),
    policyLabels: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();

const agentSkillSchema = z
  .object({
    skillId: objectIdString,
    allowedTools: z.array(identifier).max(200).optional(),
  })
  .strict();

const agentTemplateSchema = z
  .object({
    templateId: objectIdString,
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
  templates: z.array(agentTemplateSchema).max(100).default([]),
  mcpServerIds: z.array(objectIdString).max(50).default([]),
  limits: limitsSchema.default({ maxTurns: 24 }),
  contextIntelligence: contextIntelligenceConfigSchema.optional(),
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
  unique(
    value.templates.map((template) => template.templateId),
    ["templates"],
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
  const unavailable = value.tools.filter(
    (tool) => !AVAILABLE_TOOLS.includes(tool),
  );
  if (unavailable.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tools"],
      message:
        "This AgentCore deployment does not advertise: " +
        unavailable.join(", "),
    });
  }
};

export const agentCreateSchema = z
  .object(agentShape)
  .strict()
  .superRefine(refineAgent);
export const agentUpdateSchema = z
  .object(agentShape)
  .partial()
  .extend({
    description: z.string().trim().max(1_000).nullable().optional(),
    model: z.string().trim().min(1).max(300).nullable().optional(),
    contextIntelligence: z
      .union([contextIntelligenceConfigSchema, z.null()])
      .optional(),
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
  if (value.baseURL)
    validatePublicEndpoint(value.baseURL, ["baseURL"], context);
  if (value.auth.kind !== "bearer") {
    issue(
      context,
      ["auth", "kind"],
      "The deployed harness supports bearer model auth only",
    );
  }
  if (!value.apiKey) {
    issue(context, ["apiKey"], "The model provider requires apiKey");
  }
  if (value.auth.headerName) {
    issue(
      context,
      ["auth", "headerName"],
      "headerName is unsupported for bearer model auth",
    );
  }
  if (value.provider === "openrouter" && value.wire?.maxTokensField) {
    issue(
      context,
      ["wire", "maxTokensField"],
      "OpenRouter fixes the max token field",
    );
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
    baseURL: z
      .union([z.string().trim().url(), z.literal(""), z.null()])
      .optional(),
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
    if (!value.command)
      issue(context, ["command"], "stdio transport requires command");
    if (value.url) issue(context, ["url"], "stdio transport forbids url");
    if (value.headers)
      issue(context, ["headers"], "stdio transport forbids headers");
    if (value.auth.kind !== "none") {
      issue(
        context,
        ["auth", "kind"],
        "stdio transport requires auth.kind none",
      );
    }
    if (value.wire?.sessionId) {
      issue(
        context,
        ["wire", "sessionId"],
        "sessionId belongs to HTTP transport",
      );
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
      issue(
        context,
        ["headers", name],
        "Header is owned by MCP transport/auth",
      );
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
    command: z
      .union([z.string().trim().min(1).max(1_000), z.null()])
      .optional(),
    args: z
      .union([z.array(z.string().max(4_096)).max(100), z.null()])
      .optional(),
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

const skillContent = z
  .string()
  .min(1, "Skill content is required")
  .refine((value) => value.trim().length > 0, "Skill content is required")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 2_000_000,
    "Skill content must be at most 2,000,000 UTF-8 bytes",
  );

const skillRequestShape = {
  name: skillName,
  content: skillContent,
  enabled: z.boolean().default(true),
};

const skillRecordShape = {
  name: skillName,
  uri: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .regex(/^(s3:\/\/|https:\/\/)[^\s]+$/, "Expected an S3 URI"),
  enabled: z.boolean().default(true),
};

export const skillCreateSchema = z.object(skillRequestShape).strict();
export const skillUpdateSchema = z
  .object(skillRequestShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const skillRecordSchema = z
  .object({
    ...skillRecordShape,
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    createdBy: identifier,
  })
  .strict();

const templateContent = z
  .string()
  .min(1, "Template content is required")
  .refine((value) => value.trim().length > 0, "Template content is required")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 500_000,
    "Template content must be at most 500,000 UTF-8 bytes",
  );

export const TEMPLATE_FORMATS = [
  "markdown",
  "html",
  "docx",
  "xlsx",
  "csv",
  "json",
  "ndjson",
  "code",
];
const templateFormat = z.enum(TEMPLATE_FORMATS);

const templateRequestShape = {
  name: skillName,
  content: templateContent,
  format: templateFormat.default("markdown"),
  enabled: z.boolean().default(true),
};

export const templateCreateSchema = z.object(templateRequestShape).strict();
export const templateUpdateSchema = z
  .object(templateRequestShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });
export const templateRecordSchema = z
  .object({
    ...skillRecordShape,
    format: templateFormat.default("html"),
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
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.pinned !== undefined,
    // An empty patch would report success without changing anything.
    { message: "Provide title or pinned" },
  );
export const chatMessageSchema = z
  .object({
    // Not `min(1)`: files with no words is a real message, and the refinement
    // below judges the message as a whole.
    content: z.string().trim().max(2_000_000),
    /** Ids returned by POST /chats/:id/attachments, in the order to present them. */
    attachmentIds: z.array(objectIdString).max(20).default([]),
    permissionMode: z.enum(["default", "plan", "bypass", "deny"]).optional(),
    includeEvents: z.boolean().default(false),
    /**
     * Compact the agent's context before this turn runs. Set by the context meter's
     * "compact context" action; the transcript on this side is never altered.
     */
    compactContext: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => value.content.length > 0 || value.attachmentIds.length > 0,
    {
      message: "Provide a message, one or more attachments, or both",
      path: ["content"],
    },
  );

const reportCount = z.number().int().nonnegative();
const reportCountMap = z.record(reportCount);
const contextQualityDecisionSchema = z.enum([
  "ACCEPT",
  "RETRIEVE",
  "RETRIEVE_AGAIN",
  "CLARIFY",
  "CONFLICT",
  "DENY",
  "ABSTAIN",
]);
const contextNeedTypeSchema = z.enum([
  "CURRENT_EXTERNAL_INFORMATION",
  "FILE_INFORMATION",
  "DATABASE_INFORMATION",
  "API_INFORMATION",
  "MCP_DOMAIN_INFORMATION",
  "MEMORY_INFORMATION",
  "TASK_STATE_INFORMATION",
  "ARTIFACT_INFORMATION",
  "APPLICATION_CONTEXT_INFORMATION",
  "DOCUMENT_CREATION",
]);
const measuredRatioSchema = z
  .object({
    numerator: reportCount,
    denominator: reportCount,
    value: z.number().min(0).max(1),
  })
  .strict();

/** Content-free terminal outcome emitted on a warning and on the folded result. */
export const contextIntelligenceInterventionSchema = z
  .object({
    kind: z.literal("context-intelligence"),
    decision: z.enum(["CLARIFY", "CONFLICT", "DENY", "ABSTAIN"]),
    terminal: z.literal(true),
    continueToModel: z.literal(false),
    reasonCodes: z.array(z.string().max(200)).max(50),
    clarificationNeeds: z.array(contextNeedTypeSchema).max(50),
  })
  .strict();

const retrievalExecutionStateSchema = z.enum([
  "NOT_EXECUTED",
  "IN_PROGRESS",
  "SUCCESS",
  "EMPTY",
  "FAILED",
  "RETRYING",
  "EXHAUSTED",
  "BLOCKED",
]);
const retrievalAttemptTraceSchema = z
  .object({
    attemptId: z.string().min(1).max(300),
    retrievalPlanId: z.string().min(1).max(300),
    attemptNumber: reportCount,
    needId: z.string().min(1).max(300),
    informationNeed: z.string().optional(),
    normalizedRequest: z.string().optional(),
    capability: z.string().min(1).max(100),
    toolName: z.string().min(1).max(200),
    strategy: z.string().min(1).max(100),
    plannedToolInput: z.record(z.string(), z.unknown()),
    actualToolInput: z.unknown().optional(),
    actualToolResult: z.unknown().optional(),
    invokedAt: z.string().max(100).optional(),
    resultReceivedAt: z.string().max(100).optional(),
    executionState: retrievalExecutionStateSchema,
    retrievalState: retrievalExecutionStateSchema.optional(),
    observation: z
      .object({
        observationId: z.string().min(1).max(300),
        outcome: z.enum([
          "success",
          "empty",
          "partial",
          "error",
          "denied",
          "malformed",
        ]),
        content: z.string(),
        structured: z.unknown().optional(),
        source: z.record(z.string(), z.unknown()),
        provenanceId: z.string().min(1).max(300),
      })
      .passthrough()
      .optional(),
    classification: z.string().max(100).optional(),
    evidence: z.array(z.record(z.string(), z.unknown())).max(1000),
    evidenceQuality: z.record(z.string(), z.unknown()).optional(),
    sufficient: z.boolean(),
    adaptationReason: z.string().max(4000).optional(),
    previousStrategy: z.string().max(100).optional(),
    nextStrategy: z.string().max(100).optional(),
    strategyChange: z.record(z.string(), z.unknown()).optional(),
    sourceLineage: z.record(z.string(), z.unknown()).optional(),
    remainingBudget: reportCount.optional(),
    terminationReason: z.string().max(100).optional(),
  })
  .passthrough();
const groundingReportSchema = z
  .object({
    status: z.enum(["NOT_EVALUATED", "NOT_REQUIRED", "PASS", "FAIL"]),
    required: z.boolean(),
    decision: z.enum(["ACCEPT", "CLARIFY", "ABSTAIN"]).optional(),
    claimCount: reportCount,
    supportedClaimCount: reportCount,
    unsupportedClaimIds: z.array(z.string().max(300)).max(100),
    claims: z.array(z.record(z.string(), z.unknown())).max(100),
    claimsTruncated: z.boolean().optional(),
    supportingEvidenceReferences: z
      .array(z.record(z.string(), z.unknown()))
      .max(1000),
    reasonCodes: z.array(z.string().max(200)).max(100),
    checkedAt: z.string().max(100).optional(),
  })
  .passthrough();

/**
 * Context Intelligence projection emitted by the Harness. The stable aggregate
 * fields remain bounded; runtime trace fields are authoritative values produced
 * by AgentCore and are never reconstructed by the Console.
 */
export const contextIntelligenceReportSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1).max(200),
    intent: z
      .object({
        operation: z.enum([
          "answer",
          "analyze",
          "create",
          "update",
          "delete",
          "execute",
          "unknown",
        ]),
        complexity: z.enum(["simple", "compound", "complex"]),
        confidence: z.number().min(0).max(1),
        constraints: reportCount,
        requiredEntities: reportCount,
        ambiguities: reportCount,
      })
      .passthrough(),
    contextNeeds: z
      .object({
        total: reportCount,
        required: reportCount,
        missing: reportCount,
        unavailable: reportCount,
        clarificationRequired: reportCount,
        types: reportCountMap,
        capabilities: z.array(z.string().max(100)).max(50),
      })
      .passthrough()
      .optional(),
    query: z
      .object({
        variants: reportCount,
        transformations: reportCountMap,
      })
      .passthrough(),
    retrieval: z
      .object({
        providers: z.array(z.string().max(200)).max(50),
        providerCount: reportCount,
        iterations: reportCount,
        results: reportCount,
        sufficient: z.boolean(),
        insufficiencies: reportCount,
        conflicts: reportCount,
        operations: reportCount.optional(),
        operationOutcomes: reportCountMap.optional(),
        executionStates: reportCountMap.optional(),
        resourceStates: reportCountMap.optional(),
        toolNames: z.array(z.string().max(200)).max(50).optional(),
        attempts: z.array(retrievalAttemptTraceSchema).max(100).optional(),
        adaptive: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    trace: z
      .object({
        informationNeeds: z.array(z.record(z.string(), z.unknown())).max(100),
        provenance: z
          .object({
            status: z.enum(["PASS", "PARTIAL", "FAIL"]),
            stages: z.array(z.record(z.string(), z.unknown())).max(1000),
          })
          .passthrough(),
      })
      .strip()
      .optional(),
    grounding: groundingReportSchema.optional(),
    memory: z
      .object({
        recalled: reportCount,
        types: reportCountMap,
        reconciliation: z
          .object({
            retained: reportCount,
            ignored: reportCount,
            stale: reportCount,
            conflicts: reportCount,
          })
          .strict()
          .optional(),
      })
      .passthrough(),
    lifecycle: z
      .object({
        events: reportCount,
        states: reportCountMap,
      })
      .passthrough()
      .optional(),
    capabilities: z
      .object({
        available: reportCount,
        selected: reportCount,
        excluded: reportCount,
        names: z.array(z.string().max(200)).max(50),
      })
      .passthrough(),
    observations: z
      .object({
        total: reportCount,
        outcomes: reportCountMap,
        facts: reportCount,
        identifiers: reportCount,
        followUps: reportCount,
        offloaded: reportCount,
      })
      .passthrough(),
    task: z
      .object({
        status: z.enum(["active", "completed", "blocked", "failed"]),
        steps: reportCount,
        completed: reportCount,
        pending: reportCount,
        retries: reportCount,
        unresolvedIssues: reportCount,
        pendingDecisions: reportCount,
      })
      .passthrough(),
    quality: z
      .object({
        status: z.enum(["passed", "degraded", "insufficient", "rejected"]),
        decision: contextQualityDecisionSchema.optional(),
        score: z.number().min(0).max(1),
        sufficient: z.boolean(),
        conflicts: reportCount,
        issues: z
          .array(
            z
              .object({
                code: z.string().max(100),
                severity: z.enum(["info", "warning", "error"]),
                remediation: z.enum([
                  "retain",
                  "prune",
                  "compress",
                  "replace",
                  "retrieve",
                  "clarify",
                  "reject",
                ]),
                items: reportCount,
              })
              .passthrough(),
          )
          .max(1000),
      })
      .passthrough(),
    budget: z
      .object({
        inputLimit: reportCount,
        outputReservation: reportCount,
        safetyMargin: reportCount,
        availableInput: reportCount,
        usedInput: reportCount,
        allocations: z
          .array(
            z
              .object({
                category: z.string().max(100),
                maximumTokens: reportCount,
                usedTokens: reportCount,
                priority: z.number().finite(),
              })
              .passthrough(),
          )
          .max(50),
        exceeded: z.boolean(),
      })
      .passthrough(),
    finalContext: z
      .object({
        items: reportCount,
        canonicalItems: reportCount.optional(),
        activeItems: reportCount.optional(),
        evidence: reportCount,
        sources: reportCount,
        sections: reportCount,
        tools: reportCount,
        omittedItems: reportCount,
        omittedMessages: reportCount.optional(),
        offloadedArtifacts: reportCount,
        provenanceRecords: reportCount,
      })
      .passthrough(),
    intervention: z
      .object({
        required: z.boolean(),
        continueToModel: z.boolean(),
        decision: contextQualityDecisionSchema,
        reasonCodes: z.array(z.string().max(200)).max(50),
        clarificationNeeds: z.array(contextNeedTypeSchema).max(50),
      })
      .passthrough()
      .optional(),
    reasoning: z
      .object({
        mode: z.enum(["direct", "react", "alternatives", "tree"]),
        alternatives: reportCount,
        planSteps: reportCount,
      })
      .passthrough(),
    feedback: z
      .object({
        total: reportCount,
        categories: reportCountMap,
        outcomes: reportCountMap,
      })
      .passthrough()
      .optional(),
    prediction: z
      .object({
        hints: reportCount,
        satisfiedDependencies: reportCount,
        evidenceReferences: reportCount,
        truncated: z.boolean(),
      })
      .passthrough()
      .optional(),
    optimization: z
      .object({
        enabled: z.boolean(),
        eligibleProfiles: reportCount,
        reorderedSelections: reportCount,
        durationSamples: reportCount,
        costSamples: reportCount,
        unavailableReason: z
          .enum([
            "disabled",
            "no_runtime_operations",
            "insufficient_comparable_samples",
            "no_observed_cost",
          ])
          .optional(),
      })
      .passthrough()
      .optional(),
    evaluation: z
      .object({
        operationSuccess: measuredRatioSchema.optional(),
        classifiedRetrievalUsefulness: measuredRatioSchema.optional(),
        evidenceUtilization: measuredRatioSchema.optional(),
        memoryRetention: measuredRatioSchema.optional(),
        gateRejection: measuredRatioSchema.optional(),
        unclassifiedRetrievalOperations: reportCount,
        latency: z
          .object({
            samples: reportCount,
            totalMs: z.number().nonnegative(),
            meanMs: z.number().nonnegative().optional(),
            minimumMs: z.number().nonnegative().optional(),
            maximumMs: z.number().nonnegative().optional(),
          })
          .strict(),
        costs: z
          .array(
            z
              .object({
                unit: z.string().max(100),
                samples: reportCount,
                total: z.number().nonnegative(),
              })
              .strict(),
          )
          .max(1000),
        unavailable: z
          .array(
            z
              .object({
                metric: z.enum([
                  "retrieval_recall",
                  "answer_accuracy",
                  "observed_cost",
                ]),
                reason: z.enum([
                  "no_relevance_ground_truth",
                  "no_accuracy_ground_truth",
                  "no_observed_cost",
                ]),
              })
              .strict(),
          )
          .max(3),
        evaluatedAt: z.string().datetime(),
      })
      .passthrough()
      .optional(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

export const runtimeResultSchema = z
  .object({
    status: z.enum(["success", "error"]),
    sessionId: z.string().min(1).max(200),
    agentName: z.string().min(1).max(100),
    session: z
      .object({
        mode: z.enum(["persistent", "stateless"]),
        storage: z.enum(["none", "memory", "file", "s3", "custom"]).optional(),
        resumed: z.boolean(),
        origin: z.enum(["new", "store", "client_history", "stateless"]),
        historyMessageCount: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.string(),
    response: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
        z
          .object({ type: z.literal("files"), files: z.array(z.unknown()) })
          .passthrough(),
      ])
      .optional(),
    artifacts: z.array(z.unknown()).optional(),
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
    /**
     * Context occupancy at the end of the run. Optional because a runtime older
     * than the context layer, or one running a passthrough context manager with
     * no model capabilities, reports none.
     */
    context: z
      .object({
        usedTokens: z.number().nonnegative(),
        budgetTokens: z.number().nonnegative(),
        contextWindow: z.number().nonnegative().optional(),
        reservedOutputTokens: z.number().nonnegative().optional(),
        usedPercent: z.number().nonnegative(),
        compacted: z.boolean().optional(),
        compactions: z.number().int().nonnegative().optional(),
        /**
         * The run's high water mark, before compaction relieved it. Optional for
         * the same reason as the block itself: a runtime that never compacted has
         * no reading to distinguish from `usedTokens`.
         */
        peakTokens: z.number().nonnegative().optional(),
        peakPercent: z.number().nonnegative().optional(),
        /**
         * What the runtime's context orchestration layer decided.
         *
         * All optional, and the object stays `passthrough()`: a runtime older than
         * this layer reports none of it, and a runtime newer than this console may
         * report more. Neither should make a run fail to be stored — the meter
         * degrading to "used / budget" is a far better outcome than a 400.
         */
        pressure: z
          .enum(["nominal", "warning", "aggressive", "critical"])
          .optional(),
        action: z
          .enum([
            "none",
            "tool-result-trimming",
            "selective-reduction",
            "compaction",
            "reactive-compaction",
            "recovery",
          ])
          .optional(),
        strategy: z
          .enum(["passthrough", "deterministic", "llm-summarization"])
          .optional(),
        verification: z.enum(["passed", "recovered", "failed"]).optional(),
        preserved: z.array(z.string()).optional(),
        compressed: z.array(z.string()).optional(),
        recoveries: z.number().int().nonnegative().optional(),
        /** Counts per state category. Counts only: no conversation content. */
        state: z
          .object({
            goal: z.boolean().optional(),
            constraints: z.number().int().nonnegative().optional(),
            decisions: z.number().int().nonnegative().optional(),
            supersededDecisions: z.number().int().nonnegative().optional(),
            pending: z.number().int().nonnegative().optional(),
            completed: z.number().int().nonnegative().optional(),
            questions: z.number().int().nonnegative().optional(),
            errors: z.number().int().nonnegative().optional(),
            files: z.number().int().nonnegative().optional(),
            artifacts: z.number().int().nonnegative().optional(),
            toolState: z.number().int().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
        timeline: z
          .array(
            z
              .object({
                turn: z.number().int().nonnegative().optional(),
                usedPercent: z.number().nonnegative(),
                action: z.string().optional(),
                compacted: z.boolean().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    contextIntelligence: contextIntelligenceReportSchema.optional(),
    intervention: contextIntelligenceInterventionSchema.optional(),
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
    issue(
      context,
      path,
      "Endpoint URLs cannot contain credentials; use the auth fields",
    );
  }
  if (url.search || url.hash) {
    issue(
      context,
      path,
      "Endpoint URLs cannot contain query parameters or fragments; use auth or headers for credentials",
    );
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const jsonObject = z.record(z.string(), z.unknown());

export const modelBindingSchema = z
  .object({
    provider: z.enum(['anthropic', 'openrouter', 'openai-compatible']),
    model: z.string().min(1).max(300),
    secretRef: identifier,
    baseURL: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === 'openai-compatible' && !value.baseURL) {
      context.addIssue({ code: 'custom', message: 'openai-compatible model requires baseURL' });
    }
  });

export const toolBindingSchema = z
  .object({
    name: identifier,
    version: z.string().min(1).max(100),
    config: jsonObject.optional(),
  })
  .strict();

export const skillBindingSchema = z
  .object({
    name: identifier,
    version: z.string().min(1).max(100),
    description: z.string().max(1_000),
    instructions: z.string().min(1).max(200_000),
    allowedTools: z.array(identifier).optional(),
  })
  .strict();

export const dataSourceBindingSchema = z
  .object({
    name: identifier,
    type: identifier,
    version: z.string().min(1).max(100),
    config: jsonObject,
    secretRefs: z.array(identifier).optional(),
  })
  .strict();

export const mcpServerBindingSchema = z
  .object({
    name: identifier,
    version: z.string().min(1).max(100),
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    secretRefs: z.array(identifier).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transport === 'stdio' && !value.command) {
      context.addIssue({ code: 'custom', message: 'stdio MCP binding requires command' });
    }
    if (value.transport === 'http' && !value.url) {
      context.addIssue({ code: 'custom', message: 'http MCP binding requires url' });
    }
  });

const permissionRuleSchema = z
  .object({
    tool: z.string().min(1),
    decision: z.enum(['allow', 'deny']),
    inputPattern: z.string().optional(),
    source: z.string().optional(),
  })
  .strict();

export const agentDefinitionSchema = z
  .object({
    systemPrompt: z.string().min(1).max(500_000),
    model: modelBindingSchema,
    tools: z.array(toolBindingSchema).max(200).default([]),
    skills: z.array(skillBindingSchema).max(100).default([]),
    dataSources: z.array(dataSourceBindingSchema).max(100).default([]),
    mcpServers: z.array(mcpServerBindingSchema).max(50).default([]),
    permissions: z
      .object({
        mode: z.enum(['default', 'plan', 'bypass', 'deny']).default('default'),
        fallback: z.enum(['allow', 'deny', 'ask']).default('ask'),
        rules: z.array(permissionRuleSchema).max(500).default([]),
      })
      .strict()
      .default({ mode: 'default', fallback: 'ask', rules: [] }),
    limits: z
      .object({
        maxTurns: z.number().int().positive().max(1_000).default(24),
        maxInputTokens: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        maxTotalTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .strict()
      .default({ maxTurns: 24 }),
    metadata: jsonObject.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    const toolNames = new Set(value.tools.map((tool) => tool.name));
    if (toolNames.size !== value.tools.length) {
      context.addIssue({ code: 'custom', message: 'tool bindings must have unique names' });
    }
    const skillNames = new Set(value.skills.map((skill) => skill.name));
    if (skillNames.size !== value.skills.length) {
      context.addIssue({ code: 'custom', message: 'skill bindings must have unique names' });
    }
    for (const skill of value.skills) {
      for (const allowed of skill.allowedTools ?? []) {
        if (!toolNames.has(allowed)) {
          context.addIssue({
            code: 'custom',
            message: `skill ${skill.name} references unavailable tool ${allowed}`,
          });
        }
      }
    }
  });

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type ModelBinding = z.infer<typeof modelBindingSchema>;
export type ToolBinding = z.infer<typeof toolBindingSchema>;
export type SkillBinding = z.infer<typeof skillBindingSchema>;
export type DataSourceBinding = z.infer<typeof dataSourceBindingSchema>;
export type McpServerBinding = z.infer<typeof mcpServerBindingSchema>;

export type PlatformRole = 'admin' | 'editor' | 'executor' | 'viewer';

export type PlatformPrincipal = {
  tenantId: string;
  userId: string;
  roles: readonly PlatformRole[];
};

export type AgentRecord = {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  versionCounter: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  archivedAt?: string;
};

export type AgentVersionRecord = {
  id: string;
  tenantId: string;
  agentId: string;
  version: number;
  definition: AgentDefinition;
  checksum: string;
  createdAt: string;
  createdBy: string;
};

export type DeploymentRecord = {
  id: string;
  tenantId: string;
  agentId: string;
  environment: string;
  versionId: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

export type AuditRecord = {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  details: Record<string, unknown>;
};

export type ApiKeyRecord = {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  roles: PlatformRole[];
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export function parseAgentDefinition(value: unknown): AgentDefinition {
  return agentDefinitionSchema.parse(value);
}

export function definitionChecksum(definition: AgentDefinition): string {
  return createHash('sha256').update(stableJson(definition)).digest('hex');
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

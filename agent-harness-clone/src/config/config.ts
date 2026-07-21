import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const permissionRuleSchema = z.object({
  tool: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
  inputPattern: z.string().optional(),
  source: z.string().optional(),
});

export const harnessConfigSchema = z.object({
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  workingDirectory: z.string().optional(),
  limits: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  permissions: z
    .object({
      mode: z.enum(['default', 'plan', 'bypass', 'deny']).optional(),
      fallback: z.enum(['allow', 'deny', 'ask']).optional(),
      rules: z.array(permissionRuleSchema).optional(),
    })
    .optional(),
  skillDirectories: z.array(z.string()).optional(),
  pluginDirectories: z.array(z.string()).optional(),
});

export type HarnessConfig = z.infer<typeof harnessConfigSchema>;

export type ConfigLayer = {
  name: string;
  value: unknown;
};

export function mergeConfigLayers(layers: readonly ConfigLayer[]): HarnessConfig {
  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    const parsed = harnessConfigSchema.partial().parse(layer.value);
    merged = deepMerge(merged, parsed);
  }
  return harnessConfigSchema.parse(merged);
}

export async function loadJsonConfig(path: string): Promise<ConfigLayer> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return { name: path, value };
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = result[key];
    if (isRecord(existing) && isRecord(value)) result[key] = deepMerge(existing, value);
    else result[key] = structuredClone(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

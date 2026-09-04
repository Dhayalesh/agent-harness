import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/**
 * The credential, stored inline on the record.
 *
 * Whoever can write this collection can set both `apiKey` and `baseURL`, and can
 * therefore point this credential at an endpoint of their choosing. Nothing
 * outside `model_providers` constrains that, so treat write access to it as
 * equivalent to holding the key.
 */
const apiKeyValue = z.string().min(1).max(8192);

export const modelProviderAuthSchema = z
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

export const modelProviderCapabilitiesSchema = z
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
    // The entrypoint spends the window as input budget plus reply, so a reply
    // that cannot fit would leave nothing to read.
    if (value.maxOutputTokens >= value.contextWindow) {
      context.addIssue({
        code: 'custom',
        path: ['maxOutputTokens'],
        message: 'maxOutputTokens must be smaller than contextWindow',
      });
    }
  });

export const modelProviderWireSchema = z
  .object({
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    streamOptions: z.record(z.string(), z.unknown()).optional(),
    usageReporting: z.enum(['additive', 'cumulative', 'final-only']).optional(),
    toolCallIdMode: z.enum(['concat', 'replace']).optional(),
    reasoningField: z.string().min(1).max(100).optional(),
  })
  .strict();

/**
 * No id field: identity is MongoDB's own `_id`, which it assigns and indexes
 * uniquely on every document. Carrying a second application-level id would store
 * and index the same identity twice, so the stored shape is these fields plus the
 * `_id` the driver attaches (`StoredModelProviderRecord`).
 */
const modelProviderShape = {
  name: identifier,
  provider: z.enum(['openrouter', 'nvidia', 'openai-compatible', 'bedrock']),
  model: z.string().min(1).max(300),
  baseURL: z.url().optional(),
  apiKey: apiKeyValue.optional(),
  auth: modelProviderAuthSchema,
  capabilities: modelProviderCapabilitiesSchema,
  wire: modelProviderWireSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  isDefault: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: identifier,
};

type CrossFieldShape = {
  provider: 'openrouter' | 'nvidia' | 'openai-compatible' | 'bedrock';
  baseURL?: string | undefined;
  apiKey?: string | undefined;
  auth: { kind: 'bearer' | 'header' | 'none' };
};

function refineCrossFields(value: CrossFieldShape, context: z.RefinementCtx): void {
  if (value.provider !== 'openrouter' && !value.baseURL) {
    context.addIssue({
      code: 'custom',
      path: ['baseURL'],
      message: `${value.provider} model provider requires baseURL`,
    });
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

const modelProviderRecordObject = z.object(modelProviderShape).strict();

export const modelProviderRecordSchema = modelProviderRecordObject.superRefine(refineCrossFields);

/**
 * Create payload. Identity, timestamps, and provenance are deliberately absent:
 * the store assigns them, never request input.
 */
export const modelProviderInputSchema = modelProviderRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .extend({ enabled: z.boolean().default(true) })
  .strict()
  .superRefine(refineCrossFields);

/**
 * Patch shape for `update`. Identity, timestamps, and provenance are not
 * mutable. Cross-field invariants are re-checked on the merged record rather
 * than on the patch, so a partial update cannot bypass them.
 */
export const modelProviderUpdateSchema = modelProviderRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .partial()
  .strict();

export type ModelProviderRecord = z.infer<typeof modelProviderRecordSchema>;
export type ModelProviderInput = z.input<typeof modelProviderInputSchema>;
export type ModelProviderUpdate = z.infer<typeof modelProviderUpdateSchema>;
export type ModelProviderAuth = z.infer<typeof modelProviderAuthSchema>;
export type ModelProviderCapabilities = z.infer<typeof modelProviderCapabilitiesSchema>;
export type ModelProviderWire = z.infer<typeof modelProviderWireSchema>;

export function parseModelProviderInput(value: unknown): z.output<typeof modelProviderInputSchema> {
  return modelProviderInputSchema.parse(value);
}

export function parseModelProviderRecord(value: unknown): ModelProviderRecord {
  return modelProviderRecordSchema.parse(value);
}

export function parseModelProviderUpdate(value: unknown): ModelProviderUpdate {
  return modelProviderUpdateSchema.parse(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

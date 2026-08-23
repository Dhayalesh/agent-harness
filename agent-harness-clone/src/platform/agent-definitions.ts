import { z } from 'zod';

/**
 * The timestamp helper is shared with `model_providers` rather than duplicated:
 * every collection stamps ISO-8601 strings read from the same clock.
 */
export { nowIso } from './model-provider-definitions.js';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/**
 * A reference to a record in another collection, as the 24-character lowercase
 * hex form of the `ObjectId` MongoDB assigned it.
 *
 * The reference is the `_id` rather than the `name` because `_id` is the identity
 * every collection here is keyed by, and it is the only field a record cannot
 * change: renaming a model provider or an MCP server leaves every agent pointing
 * at it still pointing at it. That hex form is also already the currency of the
 * stores, since `get(id)` takes it and `toObjectId` converts it back.
 *
 * It is stored as a string, not an `ObjectId` instance, because the stores
 * `structuredClone` every field except `_id`, which would flatten an `ObjectId`
 * into a plain object on the first read (`clean` in `agent-store.ts`). Lowercase
 * only, matching what `toHexString` produces and what `toObjectId` round-trips.
 */
const objectId = z.string().regex(/^[0-9a-f]{24}$/);

/**
 * One skill this agent uses, by reference.
 *
 * The skill itself — its description, its bucket, and the path to its Markdown body
 * — lives in the `skills` collection, so many agents can share one record and a
 * change to it reaches all of them. What stays here is only the fact that this agent
 * uses it, plus the one thing that is per-agent rather than per-skill.
 *
 * `allowedTools` overrides the skill record's own list for this agent. It is an
 * object rather than a bare id for exactly that reason: the same skill given to a
 * read-only reviewer and to an editing agent should not advertise the same tools.
 * Whichever list applies must be a subset of this agent's `tools`, which
 * `refineCrossFields` checks for the override and the registry checks for the
 * inherited default.
 */
export const agentSkillSchema = z
  .object({
    skillId: objectId,
    allowedTools: z.array(identifier).max(200).optional(),
  })
  .strict();

export const agentTemplateSchema = z
  .object({
    templateId: objectId,
  })
  .strict();

/**
 * The ceilings a run is held to. Every field is honoured: they become
 * `AgentSessionConfig.limits` verbatim (`src/core/agent-session.ts`).
 *
 * `maxOutputTokens` is optional because the model provider record already carries
 * it. Setting it here narrows that budget; it cannot widen it past what the
 * provider record allows.
 *
 * There is deliberately no input token field. The input budget belongs to the
 * model, not the agent: resolution derives it as the provider's `contextWindow`
 * less the reserved reply. What an agent chooses is `compactionThresholdPercent`
 * — how full that derived budget may get before older turns are summarised out.
 * A percentage cannot be wrong in the way an absolute ceiling can, since it
 * stays meaningful when the agent is pointed at a different model.
 */
export const agentLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(1_000),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    /**
     * Percentage of the derived input budget at which context shrinks. Capped at
     * 99 because a context that only compacts once it is completely full has
     * already been rejected by the model.
     */
    compactionThresholdPercent: z.number().int().min(1).max(99).optional(),
  })
  .strict();

/**
 * No id field: identity is MongoDB's own `_id`, which it assigns and indexes
 * uniquely on every document. Carrying a second application-level id would store
 * and index the same identity twice, so the stored shape is these fields plus the
 * `_id` the driver attaches (`StoredAgentRecord`).
 *
 * `modelProviderId`, `skills[].skillId`, and `mcpServerIds` reference records in
 * `model_providers`, `skills`, and `mcp_servers` by their `_id`. MongoDB enforces no
 * foreign keys, so a reference whose target has been deleted is caught at resolution
 * rather than at write time; the operator scripts resolve and check every reference
 * up front, so a wrong one is refused before it is stored.
 *
 * This record holds no credential of its own. The key for the model lives on the
 * `model_providers` record, the keys for MCP on the `mcp_servers` records, and the
 * credential that reads skill documents belongs to the host's AWS identity, so an
 * agent can be read and listed without exposing another secret.
 */
const agentShape = {
  name: identifier,
  description: z.string().max(1_000).optional(),
  /**
   * Stored here in full. It is read on every request, so a reference would buy one
   * round trip per run for a value that is small next to the context window it is
   * spent from: at the 500,000 character ceiling it is already over half the input
   * budget of a 256k-token model, so a prompt too big for this field is one no
   * model could use. Skill bodies are the ones that grow without bound, and those
   * are referenced instead.
   */
  systemPrompt: z.string().min(1).max(500_000),
  /** `model_providers._id`. The referenced record carries the credential. */
  modelProviderId: objectId,
  /**
   * Overrides the model id on the referenced provider record for this agent
   * only. Absent means the provider record's own `model` is used.
   */
  model: z.string().min(1).max(300).optional(),
  /**
   * Names of local tools this agent may call, checked against the runtime's
   * catalogue by `assertAgentRuntimeSupport`. MCP tools are not named here: they
   * are contributed by `mcpServers` and namespaced at connect time.
   */
  tools: z.array(identifier).max(200),
  skills: z.array(agentSkillSchema).max(100),
  templates: z.array(agentTemplateSchema).max(100).optional(),
  /** `mcp_servers._id` references, connected for this agent only. */
  mcpServerIds: z.array(objectId).max(50),
  limits: agentLimitsSchema,
  enabled: z.boolean(),
  /**
   * The record a run picks when the caller names no agent. At most one record
   * holds it, the way `model_providers.isDefault` works: an agent is selected,
   * not composed, so exactly one runs. No environment variable can select a
   * record, so this flag is the only standing choice.
   */
  isDefault: z.boolean().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: identifier,
};

type CrossFieldShape = {
  tools: string[];
  skills: Array<{ skillId: string; allowedTools?: string[] | undefined }>;
  templates?: Array<{ templateId: string }> | undefined;
  mcpServerIds: string[];
};

/**
 * The three lists have to agree with each other. A duplicate resolves once and an
 * override may only allow a tool the agent actually has, so either would leave a
 * record that reads as configured while the extra value is never acted on.
 */
function refineCrossFields(value: CrossFieldShape, context: z.RefinementCtx): void {
  assertUnique(value.tools, 'tools', context);
  assertUnique(value.mcpServerIds, 'mcpServerIds', context);
  assertUnique(
    value.skills.map((skill) => skill.skillId),
    'skills',
    context,
  );
  assertUnique(
    (value.templates ?? []).map((template) => template.templateId),
    'templates',
    context,
  );

  const available = new Set(value.tools);
  for (const [index, skill] of value.skills.entries()) {
    for (const tool of skill.allowedTools ?? []) {
      if (available.has(tool)) continue;
      context.addIssue({
        code: 'custom',
        path: ['skills', index, 'allowedTools'],
        message:
          `skill ${skill.skillId} allows tool '${tool}', which is not in the agent's tools: ` +
          'the session would never offer it. Add it to tools, or drop it here.',
      });
    }
  }
}

function assertUnique(values: readonly string[], field: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!seen.has(value)) {
      seen.add(value);
      continue;
    }
    context.addIssue({
      code: 'custom',
      path: [field, index],
      message: `duplicate ${field} entry '${value}': it would resolve once either way`,
    });
  }
}

const agentRecordObject = z.object(agentShape).strict();

export const agentRecordSchema = agentRecordObject.superRefine(refineCrossFields);

/**
 * Create payload. Identity, timestamps, and provenance are deliberately absent:
 * the store assigns them, never request input. The three lists default to empty,
 * because an agent with a system prompt and a model is already runnable.
 */
export const agentInputSchema = agentRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .extend({
    enabled: z.boolean().default(true),
    tools: z.array(identifier).max(200).default([]),
    skills: z.array(agentSkillSchema).max(100).default([]),
    templates: z.array(agentTemplateSchema).max(100).default([]),
    mcpServerIds: z.array(objectId).max(50).default([]),
  })
  .strict()
  .superRefine(refineCrossFields);

/**
 * Patch shape for `update`. Identity, timestamps, and provenance are not
 * mutable. Cross-field invariants are re-checked on the merged record rather
 * than on the patch, so a partial update cannot bypass them.
 */
export const agentUpdateSchema = agentRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .partial()
  .strict();

export type AgentRecord = z.infer<typeof agentRecordSchema>;
/**
 * Named `AgentRecordInput` rather than `AgentInput`, which is already the run
 * input in `src/core/messages.ts`. Same reason for `AgentRecordLimits` against
 * `AgentLimits` in `src/core/agent-session.ts`.
 */
export type AgentRecordInput = z.input<typeof agentInputSchema>;
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;
export type AgentSkill = z.infer<typeof agentSkillSchema>;
export type AgentTemplate = z.infer<typeof agentTemplateSchema>;
export type AgentRecordLimits = z.infer<typeof agentLimitsSchema>;

export function parseAgentInput(value: unknown): z.output<typeof agentInputSchema> {
  return agentInputSchema.parse(value);
}

export function parseAgentRecord(value: unknown): AgentRecord {
  return agentRecordSchema.parse(value);
}

export function parseAgentUpdate(value: unknown): AgentUpdate {
  return agentUpdateSchema.parse(value);
}

import { z } from 'zod';
import { S3_URI_PATTERN } from '../content/s3-uri.js';

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
 * A skill name becomes a directory name under the run's temporary directory and is
 * passed to `SkillRegistry.register`, whose check is narrower than an identifier: no
 * dots, so no `..` and no extension-looking segment
 * (`src/skills/temp-skill-directory.ts`).
 */
const skillName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * Where one skill is, and what to call it. The skill itself is not here.
 *
 * Two fields are configuration: `name` and `uri`. Everything that *describes* the skill
 * — its description, its `allowedTools`, and its instructions — is the front matter and
 * body of the `SKILL.md` at that address, read fresh on every run. So a skill is
 * authored once, as a file in S3, and MongoDB cannot hold a stale copy of what it says.
 *
 * `uri` is the whole address, `s3://bucket/key`. There is no bucket collection to join
 * against and no credential stored anywhere near it: the host supplies the region and
 * AWS SDK credential chain (`skill-content.ts`), typically through its execution role.
 *
 * `name` is here rather than in the front matter because it is not a description of the
 * skill, it is the handle the platform files it under: the unique key an operator names
 * it by, the directory it is written to, and the string the model passes to the `skill`
 * tool. Keeping it in the record means renaming does not require touching S3, and two
 * skills cannot silently claim the same name.
 *
 * Nothing verifies the bytes at `uri`, and nothing bounds which keys a record may
 * address. Whoever can write the object decides what the skill instructs an agent to
 * do, and a run picks the change up immediately with no record here that it happened.
 * The bucket's IAM policy is the only thing in the way, so treat write access to it as
 * equivalent to editing every agent that uses these skills.
 *
 * No id field: identity is MongoDB's own `_id`, which it assigns and indexes uniquely
 * on every document.
 */
const skillShape = {
  name: skillName,
  /** Full S3 address of the `SKILL.md`, as `s3://bucket/key`. */
  uri: z.string().min(1).max(2048).regex(S3_URI_PATTERN),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: identifier,
};

const skillRecordObject = z.object(skillShape).strict();

export const skillRecordSchema = skillRecordObject;

/**
 * Create payload. Identity, timestamps, and provenance are deliberately absent:
 * the store assigns them, never request input.
 */
export const skillInputSchema = skillRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .extend({ enabled: z.boolean().default(true) })
  .strict();

/**
 * Patch shape for `update`. Identity, timestamps, and provenance are not mutable.
 */
export const skillUpdateSchema = skillRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .partial()
  .strict();

export type SkillRecord = z.infer<typeof skillRecordSchema>;
export type SkillRecordInput = z.input<typeof skillInputSchema>;
export type SkillUpdate = z.infer<typeof skillUpdateSchema>;

export function parseSkillInput(value: unknown): z.output<typeof skillInputSchema> {
  return skillInputSchema.parse(value);
}

export function parseSkillRecord(value: unknown): SkillRecord {
  return skillRecordSchema.parse(value);
}

export function parseSkillUpdate(value: unknown): SkillUpdate {
  return skillUpdateSchema.parse(value);
}

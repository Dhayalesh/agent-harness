import { z } from 'zod';
import { S3_URI_PATTERN } from '../content/s3-uri.js';

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const templateName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

const templateShape = {
  name: templateName,
  uri: z.string().min(1).max(2_048).regex(S3_URI_PATTERN),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: identifier,
};

const templateRecordObject = z.object(templateShape).strict();

export const templateRecordSchema = templateRecordObject;
export const templateInputSchema = templateRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .extend({ enabled: z.boolean().default(true) })
  .strict();
export const templateUpdateSchema = templateRecordObject
  .omit({ createdAt: true, updatedAt: true, createdBy: true })
  .partial()
  .strict();

export type TemplateRecord = z.infer<typeof templateRecordSchema>;
export type TemplateRecordInput = z.input<typeof templateInputSchema>;
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;

export function parseTemplateInput(value: unknown): z.output<typeof templateInputSchema> {
  return templateInputSchema.parse(value);
}

export function parseTemplateRecord(value: unknown): TemplateRecord {
  return templateRecordSchema.parse(value);
}

export function parseTemplateUpdate(value: unknown): TemplateUpdate {
  return templateUpdateSchema.parse(value);
}

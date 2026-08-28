import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import { buildXlsx } from '../../artifacts/builders/xlsx-builder.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const cell = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);
const sheet = z.object({
  name: z.string().min(1).max(31),
  columns: z.array(z.string().max(500)).min(1).max(200),
  rows: z.array(z.array(cell).max(200)).max(5_000),
});
const schema = z
  .object({
    title: z.string().min(1).max(200),
    filename: z.string().min(1).max(200),
    sheets: z.array(sheet).min(1).max(20),
  })
  .superRefine((value, context) => {
    const cells = value.sheets.reduce(
      (total, current) => total + current.columns.length * (current.rows.length + 1),
      0,
    );
    if (cells > 200_000) {
      context.addIssue({
        code: 'custom',
        path: ['sheets'],
        message: 'Workbook exceeds the 200,000-cell generation limit',
      });
    }
  });

export function createSpreadsheetArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_spreadsheet_artifact',
    description:
      'Create a downloadable Microsoft Excel .xlsx workbook from structured sheets, columns, and rows. ' +
      'Use when the requested format is Excel or .xlsx, including multi-sheet workbooks, calculations ' +
      'presented as data, or reusable Excel templates.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable workbook title' },
        filename: { type: 'string', description: 'Download filename ending in .xlsx' },
        sheets: {
          type: 'array',
          description: 'One or more worksheets',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              rows: {
                type: 'array',
                items: {
                  type: 'array',
                  items: { type: ['string', 'number', 'boolean', 'null'] },
                },
              },
            },
            required: ['name', 'columns', 'rows'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'filename', 'sheets'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const descriptor = artifactDescriptor('xlsx', input.title, input.filename, context);
      const bytes = await buildXlsx(input.title, input.sheets);
      const artifact = await store.put(bytes, descriptor);
      return {
        content: `Created Excel workbook ${descriptor.filename}`,
        metadata: { artifact },
      };
    },
  };
}

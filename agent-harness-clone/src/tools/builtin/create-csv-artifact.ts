import { z } from 'zod';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import { buildCsv } from '../../artifacts/builders/csv-builder.js';
import type { Tool } from '../tool.js';
import { artifactDescriptor } from './artifact-tool-utils.js';

const cell = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()]);
const schema = z
  .object({
    title: z.string().min(1).max(200),
    filename: z.string().min(1).max(200),
    columns: z.array(z.string().max(500)).min(1).max(200),
    rows: z.array(z.array(cell).max(200)).max(20_000),
  })
  .superRefine((value, context) => {
    if (value.columns.length * (value.rows.length + 1) > 500_000) {
      context.addIssue({
        code: 'custom',
        path: ['rows'],
        message: 'CSV exceeds the 500,000-cell generation limit',
      });
    }
  });

export function createCsvArtifactTool(store: ArtifactStore): Tool<z.infer<typeof schema>> {
  return {
    name: 'create_csv_artifact',
    description:
      'Create a downloadable UTF-8 CSV file from columns and rows. Use for portable tabular data ' +
      'or when the user explicitly asks for CSV rather than an Excel workbook.',
    inputSchema: schema,
    jsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Human-readable dataset title' },
        filename: { type: 'string', description: 'Download filename ending in .csv' },
        columns: { type: 'array', items: { type: 'string' } },
        rows: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: ['string', 'number', 'boolean', 'null'] },
          },
        },
      },
      required: ['title', 'filename', 'columns', 'rows'],
      additionalProperties: false,
    },
    kind: 'write',
    concurrencySafe: true,
    checkPermissions: () => ({ decision: 'allow' }),
    async execute(input, context) {
      const descriptor = artifactDescriptor('csv', input.title, input.filename, context);
      const artifact = await store.put(buildCsv(input.columns, input.rows), descriptor);
      return {
        content: `Created CSV dataset ${descriptor.filename}`,
        metadata: { artifact },
      };
    },
  };
}

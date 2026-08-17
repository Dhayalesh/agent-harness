import ExcelJS from 'exceljs';
import type { ArtifactCell } from './csv-builder.js';

export type ArtifactSheet = {
  name: string;
  columns: string[];
  rows: ArtifactCell[][];
};

export async function buildXlsx(
  title: string,
  sheets: readonly ArtifactSheet[],
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Agent Harness';
  workbook.title = title;
  workbook.created = new Date();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(safeSheetName(sheet.name));
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.addRow(sheet.columns);
    const header = worksheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6F4E37' } };
    for (const row of sheet.rows) worksheet.addRow(row.map(safeCell));
    worksheet.columns.forEach((column, index) => {
      const values = [sheet.columns[index] ?? '', ...sheet.rows.map((row) => row[index])];
      column.width = Math.min(
        48,
        Math.max(10, ...values.map((value) => String(value ?? '').length + 2)),
      );
    });
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: Math.max(1, sheet.columns.length) },
    };
  }

  const bytes = await workbook.xlsx.writeBuffer();
  return new Uint8Array(bytes);
}

function safeCell(value: ArtifactCell): ArtifactCell | string {
  if (typeof value !== 'string' || !/^[=+\-@]/.test(value)) return value;
  return `'${value}`;
}

function safeSheetName(value: string): string {
  return (
    value
      .replace(/[\\/*?:\[\]]/g, '-')
      .trim()
      .slice(0, 31) || 'Sheet'
  );
}

export type ArtifactCell = string | number | boolean | null;

export function buildCsv(
  columns: readonly string[],
  rows: readonly (readonly ArtifactCell[])[],
): string {
  return `\uFEFF${[columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: ArtifactCell): string {
  let text = value === null ? '' : String(value);
  // Prevent spreadsheet applications from interpreting generated text as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

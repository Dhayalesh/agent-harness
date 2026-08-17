export const ARTIFACT_FORMATS = Object.freeze({
  markdown: {
    extension: ".md",
    contentType: "text/markdown; charset=utf-8",
    label: "Markdown",
    tool: "create_markdown_artifact",
    textFallback: true,
  },
  html: {
    extension: ".html",
    contentType: "text/html; charset=utf-8",
    label: "HTML",
    tool: "create_html_artifact",
    textFallback: true,
  },
  docx: {
    extension: ".docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word document",
    tool: "create_document_artifact",
    textFallback: false,
  },
  xlsx: {
    extension: ".xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel workbook",
    tool: "create_spreadsheet_artifact",
    textFallback: false,
  },
  csv: {
    extension: ".csv",
    contentType: "text/csv; charset=utf-8",
    label: "CSV",
    tool: "create_csv_artifact",
    textFallback: true,
  },
});

export const ARTIFACT_TOOL_NAMES = new Set(
  Object.values(ARTIFACT_FORMATS).map((format) => format.tool),
);

export function artifactKind({ kind, contentType, toolName } = {}) {
  if (typeof kind === "string" && ARTIFACT_FORMATS[kind]) return kind;
  const mediaType = String(contentType ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  for (const [candidate, format] of Object.entries(ARTIFACT_FORMATS)) {
    if (format.contentType.split(";", 1)[0] === mediaType) return candidate;
    if (format.tool === toolName) return candidate;
  }
  return null;
}

export function artifactFilename(value, kind) {
  const format = ARTIFACT_FORMATS[kind];
  if (!format) return null;
  const leaf = String(value ?? `document${format.extension}`)
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const safe = (leaf || "document")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 196);
  const base = safe && safe !== "." && safe !== ".." ? safe : "document";
  return base.toLowerCase().endsWith(format.extension)
    ? base
    : `${base}${format.extension}`;
}

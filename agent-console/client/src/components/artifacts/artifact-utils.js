export const ARTIFACT_FORMATS = {
  markdown: { label: "Markdown", extension: ".md", icon: "document" },
  html: { label: "HTML", extension: ".html", icon: "code" },
  docx: { label: "Word document", extension: ".docx", icon: "document" },
  xlsx: { label: "Excel workbook", extension: ".xlsx", icon: "table" },
  csv: { label: "CSV", extension: ".csv", icon: "table" },
};

const TOOL_KINDS = {
  create_markdown_artifact: "markdown",
  create_html_artifact: "html",
  create_document_artifact: "docx",
  create_spreadsheet_artifact: "xlsx",
  create_csv_artifact: "csv",
};

export function artifactKind(artifact = {}) {
  if (ARTIFACT_FORMATS[artifact.kind]) return artifact.kind;
  if (ARTIFACT_FORMATS[artifact.metadata?.kind]) return artifact.metadata.kind;
  if (TOOL_KINDS[artifact.toolName]) return TOOL_KINDS[artifact.toolName];
  const contentType = String(artifact.contentType ?? "").toLowerCase();
  if (contentType.startsWith("text/markdown")) return "markdown";
  if (contentType.startsWith("text/html")) return "html";
  if (contentType.startsWith("text/csv")) return "csv";
  if (contentType.includes("wordprocessingml")) return "docx";
  if (contentType.includes("spreadsheetml")) return "xlsx";
  const filename = String(
    artifact.filename ?? artifact.metadata?.filename ?? "",
  ).toLowerCase();
  return (
    Object.entries(ARTIFACT_FORMATS).find(([, format]) =>
      filename.endsWith(format.extension),
    )?.[0] ?? "markdown"
  );
}

export function artifactLabel(artifact) {
  return ARTIFACT_FORMATS[artifactKind(artifact)]?.label ?? "Document";
}

export function artifactIcon(artifact) {
  return ARTIFACT_FORMATS[artifactKind(artifact)]?.icon ?? "document";
}

export function artifactModes(kind, live = false) {
  if (kind === "markdown" || kind === "html")
    return [
      ["preview", "Preview"],
      ["code", "Code"],
    ];
  if (kind === "csv")
    return [
      ["preview", "Table"],
      ["code", "Raw"],
    ];
  if (kind === "docx" && live)
    return [
      ["preview", "Preview"],
      ["code", "Source"],
    ];
  return [["preview", "Preview"]];
}

export function decodeArtifact(bytes) {
  if (!bytes) return "";
  return new TextDecoder("utf-8").decode(
    bytes instanceof ArrayBuffer ? bytes : bytes.buffer,
  );
}

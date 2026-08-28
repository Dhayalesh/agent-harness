export const ARTIFACT_FORMATS = {
  markdown: { label: "Markdown", extension: ".md", icon: "document" },
  html: { label: "HTML", extension: ".html", icon: "code" },
  docx: { label: "Word document", extension: ".docx", icon: "document" },
  xlsx: { label: "Excel workbook", extension: ".xlsx", icon: "table" },
  csv: { label: "CSV", extension: ".csv", icon: "table" },
  json: { label: "JSON", extension: ".json", icon: "code" },
  ndjson: { label: "NDJSON", extension: ".ndjson", icon: "table" },
  // Extension varies with the language; `.txt` is only the unlabelled fallback.
  code: { label: "Source code", extension: ".txt", icon: "code" },
};

/** Extension per language, mirroring CODE_LANGUAGES on the server. */
export const CODE_EXTENSIONS = {
  bash: ".sh",
  c: ".c",
  cpp: ".cpp",
  csharp: ".cs",
  css: ".css",
  dart: ".dart",
  dockerfile: ".dockerfile",
  go: ".go",
  graphql: ".graphql",
  groovy: ".groovy",
  ini: ".ini",
  java: ".java",
  javascript: ".js",
  jsx: ".jsx",
  kotlin: ".kt",
  lua: ".lua",
  makefile: ".mk",
  objectivec: ".m",
  perl: ".pl",
  php: ".php",
  powershell: ".ps1",
  python: ".py",
  r: ".r",
  ruby: ".rb",
  rust: ".rs",
  scala: ".scala",
  sql: ".sql",
  swift: ".swift",
  terraform: ".tf",
  toml: ".toml",
  tsx: ".tsx",
  typescript: ".ts",
  xml: ".xml",
  yaml: ".yaml",
  text: ".txt",
};

const TOOL_KINDS = {
  create_markdown_artifact: "markdown",
  create_html_artifact: "html",
  create_document_artifact: "docx",
  create_spreadsheet_artifact: "xlsx",
  create_csv_artifact: "csv",
  create_json_artifact: "json",
  create_code_artifact: "code",
};

export function artifactLanguage(artifact = {}) {
  const value = artifact.language ?? artifact.metadata?.language;
  return typeof value === "string" && CODE_EXTENSIONS[value] ? value : null;
}

export function artifactExtension(kind, language) {
  if (kind === "code") return CODE_EXTENSIONS[language ?? "text"] ?? ".txt";
  return ARTIFACT_FORMATS[kind]?.extension ?? ".txt";
}

export function artifactKind(artifact = {}) {
  if (ARTIFACT_FORMATS[artifact.kind]) return artifact.kind;
  if (ARTIFACT_FORMATS[artifact.metadata?.kind]) return artifact.metadata.kind;

  const toolKind = TOOL_KINDS[artifact.toolName];
  // Every tool except create_json_artifact identifies exactly one format. JSON
  // and NDJSON share a tool, so only those two may break that tie.
  if (toolKind && artifact.toolName !== "create_json_artifact") return toolKind;

  const filename = String(
    artifact.filename ?? artifact.metadata?.filename ?? "",
  ).toLowerCase();
  const contentType = String(artifact.contentType ?? "").toLowerCase();
  if (artifact.toolName === "create_json_artifact") {
    if (filename.endsWith(ARTIFACT_FORMATS.ndjson.extension)) return "ndjson";
    if (filename.endsWith(ARTIFACT_FORMATS.json.extension)) return "json";
    if (contentType.startsWith("application/x-ndjson")) return "ndjson";
    return "json";
  }

  // A language is only ever set on a code artifact, so it identifies one before
  // a generic text/plain content type gets a chance to hide it.
  if (artifactLanguage(artifact)) return "code";
  if (
    Object.values(CODE_EXTENSIONS).some(
      (extension) => extension !== ".txt" && filename.endsWith(extension),
    )
  ) {
    return "code";
  }
  const filenameKind = Object.entries(ARTIFACT_FORMATS).find(
    // `code` is excluded: its `.txt` fallback would claim every plain-text name.
    ([kind, format]) => kind !== "code" && filename.endsWith(format.extension),
  )?.[0];
  if (filenameKind) return filenameKind;

  if (contentType.startsWith("text/markdown")) return "markdown";
  if (contentType.startsWith("text/html")) return "html";
  if (contentType.startsWith("text/csv")) return "csv";
  if (contentType.startsWith("application/x-ndjson")) return "ndjson";
  if (contentType.startsWith("application/json")) return "json";
  if (contentType.includes("wordprocessingml")) return "docx";
  if (contentType.includes("spreadsheetml")) return "xlsx";
  return "markdown";
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
  if (kind === "ndjson")
    return [
      ["preview", "Records"],
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

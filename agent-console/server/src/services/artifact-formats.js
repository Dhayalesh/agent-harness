/**
 * Mirrors `src/artifacts/artifact-formats.ts` in the harness.
 *
 * The harness decides what it can generate; this table decides what the console
 * will accept back. A kind missing here is dropped by `presentedArtifact`, so the
 * two lists have to move together.
 */
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
  json: {
    extension: ".json",
    contentType: "application/json; charset=utf-8",
    label: "JSON",
    tool: "create_json_artifact",
    textFallback: true,
  },
  ndjson: {
    extension: ".ndjson",
    contentType: "application/x-ndjson; charset=utf-8",
    label: "NDJSON",
    // Shares one tool with `json`; the two are told apart by `metadata.kind`,
    // which the harness always sets. `tool` here is only a last-resort fallback.
    tool: "create_json_artifact",
    textFallback: true,
  },
  /**
   * Source code, in any of `CODE_LANGUAGES`. The only kind whose extension is not
   * fixed — the language decides it, and `extension` here is the fallback used
   * when no language was named. The content type stays `text/plain` for every
   * language so a browser never renders or executes what it is handed.
   */
  code: {
    extension: ".txt",
    contentType: "text/plain; charset=utf-8",
    label: "Source code",
    tool: "create_code_artifact",
    textFallback: true,
  },
});

/** Mirrors `CODE_LANGUAGES` in the harness. Extension only. */
export const CODE_LANGUAGES = Object.freeze({
  bash: { extension: ".sh", label: "Bash" },
  c: { extension: ".c", label: "C" },
  cpp: { extension: ".cpp", label: "C++" },
  csharp: { extension: ".cs", label: "C#" },
  css: { extension: ".css", label: "CSS" },
  dart: { extension: ".dart", label: "Dart" },
  dockerfile: { extension: ".dockerfile", label: "Dockerfile" },
  go: { extension: ".go", label: "Go" },
  graphql: { extension: ".graphql", label: "GraphQL" },
  groovy: { extension: ".groovy", label: "Groovy" },
  ini: { extension: ".ini", label: "INI" },
  java: { extension: ".java", label: "Java" },
  javascript: { extension: ".js", label: "JavaScript" },
  jsx: { extension: ".jsx", label: "JavaScript (JSX)" },
  kotlin: { extension: ".kt", label: "Kotlin" },
  lua: { extension: ".lua", label: "Lua" },
  makefile: { extension: ".mk", label: "Makefile" },
  objectivec: { extension: ".m", label: "Objective-C" },
  perl: { extension: ".pl", label: "Perl" },
  php: { extension: ".php", label: "PHP" },
  powershell: { extension: ".ps1", label: "PowerShell" },
  python: { extension: ".py", label: "Python" },
  r: { extension: ".r", label: "R" },
  ruby: { extension: ".rb", label: "Ruby" },
  rust: { extension: ".rs", label: "Rust" },
  scala: { extension: ".scala", label: "Scala" },
  sql: { extension: ".sql", label: "SQL" },
  swift: { extension: ".swift", label: "Swift" },
  terraform: { extension: ".tf", label: "Terraform" },
  toml: { extension: ".toml", label: "TOML" },
  tsx: { extension: ".tsx", label: "TypeScript (TSX)" },
  typescript: { extension: ".ts", label: "TypeScript" },
  xml: { extension: ".xml", label: "XML" },
  yaml: { extension: ".yaml", label: "YAML" },
  text: { extension: ".txt", label: "Plain text" },
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
    // `code` is skipped: every language shares text/plain, so a content type
    // cannot identify one. It is still reachable through `kind` and `toolName`.
    if (candidate !== "code" && format.contentType.split(";", 1)[0] === mediaType)
      return candidate;
    if (format.tool === toolName) return candidate;
  }
  return null;
}

/** A language name the harness recognises, or null. */
export function codeLanguage(value) {
  return typeof value === "string" && CODE_LANGUAGES[value] ? value : null;
}

/** The extension a kind's downloads carry, resolving `code` through its language. */
export function artifactExtension(kind, { language } = {}) {
  const format = ARTIFACT_FORMATS[kind];
  if (!format) return null;
  if (kind === "code") {
    return CODE_LANGUAGES[codeLanguage(language) ?? "text"].extension;
  }
  return format.extension;
}

export function artifactFilename(value, kind, options = {}) {
  const extension = artifactExtension(kind, options);
  if (!extension) return null;
  const leaf = String(value ?? `document${extension}`)
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const safe = (leaf || "document")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 196);
  const base = safe && safe !== "." && safe !== ".." ? safe : "document";
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

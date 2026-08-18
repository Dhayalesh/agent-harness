import { CODE_LANGUAGES } from "./artifact-formats.js";

/**
 * What a chat will accept as an upload, and how each file is turned into context.
 *
 * Keyed by extension rather than by the browser's `Content-Type`. Browsers report
 * almost nothing useful for source files — a `.go` file arrives as an empty type or
 * `application/octet-stream` depending on the platform — so the extension decides
 * and the reported type is only a cross-check.
 *
 * `handling` says how the bytes become model input:
 * - `text`   decode as UTF-8
 * - `docx`   OOXML Word part, extracted to text
 * - `xlsx`   OOXML workbook, extracted to a text grid per sheet
 * - `image`  passed through as a base64 image block
 */

const CODE_BY_EXTENSION = new Map(
  Object.entries(CODE_LANGUAGES).map(([language, format]) => [
    format.extension,
    { language, label: format.label },
  ]),
);

/** Types that are not source code but are still read as text. */
const TEXT_TYPES = {
  ".md": { contentType: "text/markdown", label: "Markdown", language: "markdown" },
  ".markdown": { contentType: "text/markdown", label: "Markdown", language: "markdown" },
  ".txt": { contentType: "text/plain", label: "Plain text" },
  ".text": { contentType: "text/plain", label: "Plain text" },
  ".log": { contentType: "text/plain", label: "Log" },
  ".csv": { contentType: "text/csv", label: "CSV", language: "csv" },
  ".tsv": { contentType: "text/tab-separated-values", label: "TSV", language: "csv" },
  ".json": { contentType: "application/json", label: "JSON", language: "json" },
  ".ndjson": { contentType: "application/x-ndjson", label: "NDJSON", language: "json" },
  ".jsonl": { contentType: "application/x-ndjson", label: "NDJSON", language: "json" },
  ".html": { contentType: "text/html", label: "HTML", language: "html" },
  ".htm": { contentType: "text/html", label: "HTML", language: "html" },
  // XML rather than an image: an SVG is markup, and treating it as text keeps it
  // out of any renderer.
  ".svg": { contentType: "image/svg+xml", label: "SVG markup", language: "xml" },
  ".rst": { contentType: "text/plain", label: "reStructuredText" },
  ".patch": { contentType: "text/plain", label: "Patch", language: "text" },
  ".diff": { contentType: "text/plain", label: "Diff", language: "text" },
};

const IMAGE_TYPES = {
  ".png": { contentType: "image/png", label: "PNG image" },
  ".jpg": { contentType: "image/jpeg", label: "JPEG image" },
  ".jpeg": { contentType: "image/jpeg", label: "JPEG image" },
  ".gif": { contentType: "image/gif", label: "GIF image" },
  ".webp": { contentType: "image/webp", label: "WebP image" },
};

const DOCUMENT_TYPES = {
  ".docx": {
    handling: "docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word document",
  },
  ".xlsx": {
    handling: "xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel workbook",
  },
  ".xlsm": {
    handling: "xlsx",
    contentType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    label: "Excel workbook",
  },
};

/**
 * Formats worth a specific refusal rather than "unsupported".
 *
 * The pre-2007 Office formats are not zip containers, and a user handed
 * "unsupported file type" for a .doc has no idea that saving as .docx would work.
 */
const KNOWN_UNSUPPORTED = {
  ".doc": "Word 97-2003 files are not supported. Save as .docx and upload again.",
  ".xls": "Excel 97-2003 files are not supported. Save as .xlsx and upload again.",
  ".ppt": "PowerPoint files are not supported.",
  ".pptx": "PowerPoint files are not supported.",
  ".pdf": "PDF files are not supported yet.",
  ".zip": "Archives are not supported. Upload the files inside it.",
  ".rar": "Archives are not supported. Upload the files inside it.",
  ".7z": "Archives are not supported. Upload the files inside it.",
  ".exe": "Executables are not supported.",
  ".dll": "Executables are not supported.",
};

export function attachmentExtension(filename) {
  const leaf = String(filename ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .toLowerCase();
  const dot = leaf.lastIndexOf(".");
  // A dotfile such as `.gitignore` has no extension, only a leading dot.
  return dot > 0 ? leaf.slice(dot) : "";
}

/**
 * How an upload will be handled, or a reason it will not be.
 *
 * Returns `{ supported: false, reason }` rather than throwing, so the route can
 * accept the files it understands and report the ones it does not.
 */
export function describeAttachment(filename) {
  const extension = attachmentExtension(filename);
  if (!extension) {
    return {
      supported: false,
      reason: "File has no extension, so its type cannot be determined.",
    };
  }
  if (KNOWN_UNSUPPORTED[extension]) {
    return { supported: false, reason: KNOWN_UNSUPPORTED[extension] };
  }

  const image = IMAGE_TYPES[extension];
  if (image) {
    return { supported: true, extension, handling: "image", ...image };
  }
  const document = DOCUMENT_TYPES[extension];
  if (document) {
    return { supported: true, extension, ...document };
  }
  const text = TEXT_TYPES[extension];
  if (text) {
    return { supported: true, extension, handling: "text", ...text };
  }
  const code = CODE_BY_EXTENSION.get(extension);
  if (code) {
    return {
      supported: true,
      extension,
      handling: "text",
      contentType: "text/plain",
      label: `${code.label} source`,
      language: code.language,
    };
  }
  return {
    supported: false,
    reason: `${extension} files are not supported.`,
  };
}

/**
 * A stored, displayed and downloaded name derived from what the browser sent.
 *
 * Applied after `describeAttachment`, which reads the original: sanitising first
 * could strip the extension the type detection depends on.
 */
export function safeUploadFilename(value) {
  const leaf = String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const cleaned = (leaf || "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/[^A-Za-z0-9._ ()-]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot or dash would make the name read as a dotfile or a CLI flag.
    .replace(/^[-.]+/, "")
    .slice(0, 200);
  return cleaned || "upload";
}

/** Every extension a chat accepts, for the file picker's `accept` attribute. */
export function acceptedExtensions() {
  return [
    ...Object.keys(IMAGE_TYPES),
    ...Object.keys(DOCUMENT_TYPES),
    ...Object.keys(TEXT_TYPES),
    ...CODE_BY_EXTENSION.keys(),
  ].sort();
}

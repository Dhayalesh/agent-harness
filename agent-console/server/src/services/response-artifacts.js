import {
  ARTIFACT_FORMATS,
  ARTIFACT_TOOL_NAMES,
  artifactExtension,
  artifactFilename,
  artifactKind,
  codeLanguage,
} from "./artifact-formats.js";

const MAX_TEXT_CHARS = 2_000_000;

/** Hydrates supported generated-file references from a buffered runtime result. */
export function hydrateRuntimeArtifacts(result) {
  const calls = toolCalls(result?.messages);
  const artifacts = (result?.artifacts ?? []).flatMap((artifact) => {
    const callId = artifact?.metadata?.toolCallId;
    const call = callId ? calls.get(callId) : undefined;
    const hydrated = presentedArtifact(artifact, call?.input, call?.name);
    return hydrated ? [hydrated] : [];
  });
  return {
    ...result,
    output: result?.output ?? "",
    artifacts,
    response: artifacts.length
      ? { type: "files", files: artifacts }
      : { type: "text", text: result?.output ?? "" },
  };
}

/** Converts one supported artifact event into the bounded reference stored with a chat. */
export function presentedArtifact(artifact, input, toolName) {
  if (!artifact || typeof artifact !== "object") return null;
  if (typeof artifact.id !== "string" || !artifact.id) return null;
  const parsed = parseInput(input);
  const metadata = artifact.metadata ?? {};
  const kind = artifactKind({
    kind: metadata.kind,
    contentType: artifact.contentType,
    toolName,
  });
  if (!kind) return null;
  const format = ARTIFACT_FORMATS[kind];
  // Only `code` varies its extension, and only it carries a language.
  const language =
    kind === "code"
      ? codeLanguage(metadata.language ?? parsed?.language)
      : null;
  const options = language ? { language } : {};
  const filename = artifactFilename(
    metadata.filename ?? parsed?.filename,
    kind,
    options,
  );
  if (!filename) return null;
  const extension = artifactExtension(kind, options);
  const title = cleanTitle(
    metadata.title ?? parsed?.title ?? filename.slice(0, -extension.length),
  );
  const base = {
    id: artifact.id,
    kind,
    ...(language ? { language } : {}),
    contentType: format.contentType,
    size: Number.isSafeInteger(artifact.size) ? artifact.size : 0,
    createdAt:
      typeof artifact.createdAt === "string"
        ? artifact.createdAt
        : new Date().toISOString(),
    filename,
    title,
  };
  const storage = s3Storage(artifact.storage);
  if (storage) return { ...base, storage };

  // Local/older runtimes can safely retain only text formats. Binary office
  // files must have a durable S3 reference; source text is not a DOCX/XLSX file.
  const content = format.textFallback
    ? fallbackContent(kind, parsed)
    : undefined;
  if (typeof content !== "string" || content.length > MAX_TEXT_CHARS)
    return null;
  return {
    ...base,
    size: Buffer.byteLength(content, "utf8"),
    content,
  };
}

function fallbackContent(kind, parsed) {
  if (kind !== "csv") return parsed?.content;
  if (!Array.isArray(parsed?.columns) || !Array.isArray(parsed?.rows))
    return undefined;
  return (
    "\uFEFF" +
    [parsed.columns, ...parsed.rows]
      .map((row) => (Array.isArray(row) ? row.map(csvCell).join(",") : ""))
      .join("\r\n") +
    "\r\n"
  );
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Backward-compatible export for existing imports and integrations. */
export const presentedMarkdownArtifact = presentedArtifact;

/** Run records need discoverability, but the chat owns the stored byte reference. */
export function artifactMetadata(artifacts) {
  return (artifacts ?? []).map(
    ({ content: _content, ...artifact }) => artifact,
  );
}

function toolCalls(messages) {
  const calls = new Map();
  for (const message of messages ?? []) {
    for (const block of Array.isArray(message?.content)
      ? message.content
      : []) {
      if (
        block?.type !== "tool_call" ||
        !ARTIFACT_TOOL_NAMES.has(block.name) ||
        typeof block.id !== "string"
      )
        continue;
      calls.set(block.id, { name: block.name, input: block.input });
    }
  }
  return calls;
}

function parseInput(input) {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function cleanTitle(value) {
  return (
    String(value ?? "Document")
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .trim()
      .slice(0, 200) || "Document"
  );
}

function s3Storage(value) {
  if (!value || typeof value !== "object" || value.kind !== "s3") return null;
  if (!validBucket(value.bucket) || !validKey(value.key)) return null;
  const storage = { kind: "s3", bucket: value.bucket, key: value.key };
  for (const field of ["region", "versionId", "etag", "checksumSha256"]) {
    if (typeof value[field] === "string" && value[field].length <= 1_024) {
      storage[field] = value[field];
    }
  }
  return storage;
}

function validBucket(value) {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
  );
}

function validKey(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !/[\x00-\x1F\x7F]/.test(value)
  );
}

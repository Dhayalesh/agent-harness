import { config } from "../config.js";
import { docxToText, xlsxToSheets } from "./ooxml.js";

/**
 * Turns uploaded bytes into something a model can read, once, at upload time.
 *
 * Extraction happens here rather than in the harness for two reasons. A 20 MB
 * workbook cannot cross the wire as base64 inside the console's 5 MB JSON body or
 * the harness's 8 MB one, but the few thousand characters of text inside it can.
 * And doing it on upload means a file that cannot be read says so while the user is
 * still looking at the composer, instead of failing mid-turn.
 *
 * Never throws for bad input: an unreadable file becomes `{ ok: false, reason }` so
 * the route can reject that one file and keep the rest.
 */
export function extractAttachment(buffer, descriptor) {
  try {
    if (descriptor.handling === "image") return extractImage(buffer, descriptor);
    if (descriptor.handling === "docx") return extractDocx(buffer);
    if (descriptor.handling === "xlsx") return extractXlsx(buffer);
    return extractText(buffer);
  } catch (error) {
    return {
      ok: false,
      reason: `Could not read the file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function extractImage(buffer, descriptor) {
  if (buffer.byteLength > config.uploads.maxImageBytes) {
    return {
      ok: false,
      reason:
        `Images must be ${megabytes(config.uploads.maxImageBytes)} or smaller ` +
        `because they are sent to the model inline. This one is ${megabytes(buffer.byteLength)}.`,
    };
  }
  if (!imageBytesMatch(buffer, descriptor.contentType)) {
    return {
      ok: false,
      reason: "File contents do not match its image extension.",
    };
  }
  return { ok: true, handling: "image", text: null, notes: [] };
}

function extractText(buffer) {
  if (looksBinary(buffer)) {
    return {
      ok: false,
      reason: "File looks binary rather than text, so it cannot be read.",
    };
  }
  const decoded = decodeUtf8(buffer);
  if (!decoded.text.trim()) {
    return { ok: false, reason: "File is empty." };
  }
  const clamped = clamp(decoded.text, config.uploads.maxTextChars);
  return {
    ok: true,
    handling: "text",
    text: clamped.text,
    notes: [...decoded.notes, ...clamped.notes],
  };
}

function extractDocx(buffer) {
  const text = docxToText(buffer, { maxChars: config.uploads.maxTextChars });
  if (!text.trim()) {
    return { ok: false, reason: "The document contains no readable text." };
  }
  return { ok: true, handling: "text", text, notes: [] };
}

function extractXlsx(buffer) {
  const sheets = xlsxToSheets(buffer);
  if (!sheets.length) {
    return { ok: false, reason: "The workbook contains no sheets." };
  }
  const rendered = sheets
    .map((sheet) => {
      const body = sheet.rows.map((row) => row.join("\t")).join("\n");
      return `# Sheet: ${sheet.name}\n${body || "(empty)"}`;
    })
    .join("\n\n");
  const clamped = clamp(rendered, config.uploads.maxTextChars);
  return {
    ok: true,
    handling: "text",
    text: clamped.text,
    notes: [
      // Tab-separated so a cell containing a comma needs no quoting, which keeps
      // the grid readable to a model without a CSV parser.
      `${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"}, tab-separated`,
      ...clamped.notes,
    ],
  };
}

/**
 * UTF-8 with a BOM stripped, reporting whether anything failed to decode.
 *
 * `fatal: false` means a mis-detected encoding produces replacement characters
 * rather than an error, so a Latin-1 file still yields mostly-correct text; the
 * note tells the reader why some characters look wrong.
 */
function decodeUtf8(buffer) {
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(buffer)
    .replace(/^\uFEFF/, "")
    // Normalise line endings so a CRLF file does not double-space in the prompt.
    .replace(/\r\n?/g, "\n");
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  const notes =
    replacements > 8
      ? ["some characters could not be decoded as UTF-8"]
      : [];
  return { text, notes };
}

/** A NUL byte in the first few KB is the reliable signal that this is not text. */
function looksBinary(buffer) {
  const window = buffer.subarray(0, 8_192);
  return window.includes(0);
}

const IMAGE_SIGNATURES = [
  { contentType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { contentType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { contentType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * Confirms the bytes are the image type the extension claims.
 *
 * Not a security boundary on its own — the download route also sends `nosniff` and
 * never serves an uploaded file as HTML — but it stops a mislabelled file from
 * being sent to a model as an image it cannot decode.
 */
function imageBytesMatch(buffer, contentType) {
  if (contentType === "image/webp") {
    return (
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  const signature = IMAGE_SIGNATURES.find(
    (candidate) => candidate.contentType === contentType,
  );
  if (!signature) return true;
  return signature.bytes.every((byte, index) => buffer[index] === byte);
}

function clamp(text, maximum) {
  if (text.length <= maximum) return { text, notes: [] };
  return {
    text: text.slice(0, maximum),
    notes: [`truncated to the first ${maximum.toLocaleString()} characters`],
  };
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

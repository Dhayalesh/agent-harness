import { openZip } from "./zip-reader.js";

/**
 * Word and Excel documents as plain text a model can read.
 *
 * Both formats are OOXML: a zip of XML parts. Only the parts that carry content
 * are parsed, with regular expressions rather than a full XML parser, which is
 * safe here because the input is machine-generated markup with a fixed shape and
 * the output is text rather than a document tree.
 */

/** Paragraphs, tabs and line breaks preserved; everything else discarded. */
export function docxToText(buffer, { maxChars = 400_000 } = {}) {
  const zip = openZip(buffer);
  const document = zip.readText("word/document.xml");
  if (document === null) {
    throw new Error("Not a Word document: word/document.xml is missing");
  }
  const text = document
    // Deleted revisions are not part of the document's text.
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, "")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    // A table row should not run into the next one.
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return clamp(decodeXmlEntities(text).trim(), maxChars);
}

/**
 * Every sheet as a name plus a row/cell grid.
 *
 * Shared strings, inline strings and numbers are resolved. Dates are converted
 * from their serial numbers, because a column of `45292` values tells a model
 * nothing about what it is looking at.
 */
export function xlsxToSheets(buffer, { maxRows = 5_000, maxColumns = 256 } = {}) {
  const zip = openZip(buffer);
  const workbook = zip.readText("xl/workbook.xml");
  if (workbook === null) {
    throw new Error("Not an Excel workbook: xl/workbook.xml is missing");
  }
  const sharedStrings = readSharedStrings(zip);
  const dateStyles = readDateStyles(zip);
  const relations = readRelationships(zip);

  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXmlEntities(attribute(match[1], "name") ?? `Sheet${sheets.length + 1}`);
    const relationId = attribute(match[1], "r:id");
    const target = relationId ? relations.get(relationId) : undefined;
    const path = target
      ? `xl/${String(target).replace(/^\/?xl\//, "").replace(/^\//, "")}`
      : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = zip.readText(path);
    if (xml === null) continue;
    sheets.push({
      name,
      rows: readSheetRows(xml, { sharedStrings, dateStyles, maxRows, maxColumns }),
    });
  }
  return sheets;
}

function readSheetRows(xml, { sharedStrings, dateStyles, maxRows, maxColumns }) {
  const rows = [];
  let truncated = false;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const reference = attribute(cellMatch[1], "r");
      const index = reference ? columnIndex(reference) : cells.length;
      if (index >= maxColumns) continue;
      // Sparse rows omit empty cells, so the reference decides the position.
      while (cells.length < index) cells.push("");
      cells[index] = cellValue(cellMatch[1], cellMatch[2] ?? "", {
        sharedStrings,
        dateStyles,
      });
    }
    rows.push(cells);
  }
  // Trailing blank rows are an artefact of the format, not data.
  while (rows.length && rows.at(-1).every((cell) => cell === "")) rows.pop();
  if (truncated) rows.push([`... truncated at ${maxRows} rows`]);
  return rows;
}

function cellValue(attributes, body, { sharedStrings, dateStyles }) {
  const type = attribute(attributes, "t");
  if (type === "inlineStr") {
    return decodeXmlEntities(textRuns(body));
  }
  const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) {
    // A formula cell with no cached result, or a genuinely empty styled cell.
    return type === "str" ? decodeXmlEntities(textRuns(body)) : "";
  }
  if (type === "s") {
    return sharedStrings[Number.parseInt(raw, 10)] ?? "";
  }
  if (type === "str") return decodeXmlEntities(raw);
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  if (type === "e") return decodeXmlEntities(raw);

  const styleId = Number.parseInt(attribute(attributes, "s") ?? "", 10);
  if (Number.isInteger(styleId) && dateStyles.has(styleId)) {
    const formatted = excelSerialToText(Number(raw));
    if (formatted) return formatted;
  }
  return decodeXmlEntities(raw);
}

function readSharedStrings(zip) {
  const xml = zip.readText("xl/sharedStrings.xml");
  if (xml === null) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeXmlEntities(textRuns(match[1])),
  );
}

/** `<t>` runs concatenated, which is how a styled string is stored. */
function textRuns(fragment) {
  const parts = [...fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(
    (match) => match[1],
  );
  return parts.length ? parts.join("") : "";
}

function readRelationships(zip) {
  const xml = zip.readText("xl/_rels/workbook.xml.rels");
  const relations = new Map();
  if (xml === null) return relations;
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attribute(match[1], "Id");
    const target = attribute(match[1], "Target");
    if (id && target) relations.set(id, target);
  }
  return relations;
}

/**
 * Style indexes whose number format is a date or time.
 *
 * Builtin ids are fixed by the specification; a custom format is treated as a date
 * when its code contains date or time placeholders outside a literal section.
 */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57,
]);

function readDateStyles(zip) {
  const styles = new Set();
  const xml = zip.readText("xl/styles.xml");
  if (xml === null) return styles;

  const customDateFormats = new Set();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number.parseInt(attribute(match[1], "numFmtId") ?? "", 10);
    const code = decodeXmlEntities(attribute(match[1], "formatCode") ?? "");
    if (Number.isInteger(id) && looksLikeDateFormat(code)) customDateFormats.add(id);
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  let index = 0;
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number.parseInt(attribute(match[1], "numFmtId") ?? "", 10);
    if (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id)) styles.add(index);
    index += 1;
  }
  return styles;
}

function looksLikeDateFormat(code) {
  // Quoted literals and colour/condition sections can contain letters that would
  // otherwise read as placeholders.
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/^[^dmyhs]*$/i.test(bare);
}

/** Excel counts days from 1899-12-30, a consequence of its 1900 leap-year bug. */
const EXCEL_EPOCH_OFFSET_DAYS = 25_569;

function excelSerialToText(serial) {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const milliseconds = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * 86_400_000);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  // A value below 1 is a time of day with no date component.
  if (serial < 1) return iso.slice(11, 19);
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** `A` is 0, `AA` is 26. Trailing digits are the row and are ignored. */
function columnIndex(reference) {
  let index = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return Math.max(0, index - 1);
}

function attribute(attributes, name) {
  const match = new RegExp(`\\b${name.replace(":", "\\:")}="([^"]*)"`).exec(
    attributes ?? "",
  );
  return match?.[1];
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      safeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, digits) =>
      safeCodePoint(Number.parseInt(digits, 10)),
    )
    // Ampersand last, so `&amp;lt;` does not become `<`.
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function clamp(value, maximum) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n\n... truncated at ${maximum} characters`;
}

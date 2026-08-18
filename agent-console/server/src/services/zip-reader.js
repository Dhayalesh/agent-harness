import { inflateRawSync } from "node:zlib";

/**
 * Just enough ZIP to read an OOXML container.
 *
 * `.docx` and `.xlsx` are both ZIP archives of XML parts, so one reader covers
 * Word and Excel ingestion. Written against `node:zlib` rather than pulling in an
 * archive library: the alternative on offer brought a transitive advisory and most
 * of a megabyte to extract two known filenames from a well-formed archive.
 *
 * Entries are located from the central directory and inflated on demand, so
 * reading `word/document.xml` out of a workbook full of media never touches the
 * media.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
/** The comment length field is 16 bits, which bounds how far back the EOCD can sit. */
const MAX_EOCD_SEARCH = 65_535 + 22;

export class ZipError extends Error {}

export function openZip(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? 4_096;
  const maxEntryBytes = options.maxEntryBytes ?? 64 * 1024 * 1024;
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_MARKER || entryCount === 0xffff) {
    throw new ZipError("Zip64 archives are not supported");
  }
  if (entryCount > maxEntries) {
    throw new ZipError(`Archive has ${entryCount} entries; maximum is ${maxEntries}`);
  }

  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) throw new ZipError("Truncated central directory");
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError("Corrupt central directory entry");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    // Directory markers carry no data and would only confuse a lookup by name.
    if (!name.endsWith("/")) {
      entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      return readEntry(buffer, entry, maxEntryBytes);
    },
    readText(name) {
      const bytes = this.read(name);
      return bytes === null ? null : stripBom(bytes.toString("utf8"));
    },
  };
}

function readEntry(buffer, entry, maxEntryBytes) {
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new ZipError(
      `Entry expands to ${entry.uncompressedSize} bytes; maximum is ${maxEntryBytes}`,
    );
  }
  const header = entry.localOffset;
  if (header + 30 > buffer.length) throw new ZipError("Truncated local header");
  if (buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError("Corrupt local file header");
  }
  // The local header repeats the name and extra lengths, and they can differ from
  // the central directory's, so the data offset is computed from the local copy.
  const nameLength = buffer.readUInt16LE(header + 26);
  const extraLength = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new ZipError("Truncated entry data");
  const raw = buffer.subarray(start, end);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) {
    throw new ZipError(`Unsupported compression method ${entry.method}`);
  }
  const inflated = inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
  return Buffer.from(inflated);
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw new ZipError("File is too small to be a zip archive");
  const limit = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= limit; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("Not a zip archive");
}

function stripBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

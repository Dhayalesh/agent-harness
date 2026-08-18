import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractAttachment } from "../src/services/attachment-extract.js";
import {
  acceptedExtensions,
  attachmentExtension,
  describeAttachment,
  safeUploadFilename,
} from "../src/services/attachment-types.js";
import { docxToText, xlsxToSheets } from "../src/services/ooxml.js";
import { openZip, ZipError } from "../src/services/zip-reader.js";
import { chatMessageSchema } from "../src/lib/schemas.js";

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

test("the zip reader lists and inflates a real OOXML container", () => {
  const zip = openZip(fixture("sample.docx"));

  assert.ok(zip.has("word/document.xml"));
  assert.ok(zip.names.includes("[Content_Types].xml"));
  assert.match(zip.readText("word/document.xml"), /^<\?xml/);
  assert.equal(zip.read("does/not/exist.xml"), null);
});

test("the zip reader rejects something that is not an archive", () => {
  assert.throws(() => openZip(Buffer.from("not a zip at all")), ZipError);
  assert.throws(() => openZip(Buffer.alloc(4)), ZipError);
});

test("a Word document becomes paragraphs of decoded text", () => {
  const text = docxToText(fixture("sample.docx"));

  assert.match(text, /^Quarterly Report$/m);
  // Entities must be decoded, and decoded once: `&amp;` is `&`, not `&amp;`.
  assert.match(text, /Revenue grew 12% & costs fell\./);
  assert.match(text, /Line with a <tag> inside it/);
  assert.match(text, /Final note — dash and “quotes”\./);
  assert.ok(!text.includes("<w:p"), "markup should not survive");
  assert.ok(!/\n{3,}/.test(text), "blank runs should be collapsed");
});

test("an Excel workbook becomes one grid per sheet, with dates resolved", () => {
  const sheets = xlsxToSheets(fixture("sample.xlsx"));

  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ["People", "Notes"],
  );
  assert.deepEqual(sheets[0].rows[0], ["Name", "Joined", "Score", "Active"]);
  assert.equal(sheets[0].rows[1][0], "Alice");
  // A date column must not arrive as the serial number 46037.
  assert.equal(sheets[0].rows[1][1], "2026-01-15");
  assert.equal(sheets[0].rows[1][2], "91.5");
  assert.equal(sheets[0].rows[1][3], "TRUE");
  assert.equal(sheets[0].rows[2][1], "2025-11-02");
  assert.equal(sheets[0].rows[2][3], "FALSE");
  assert.equal(sheets[1].rows[1][0], "Contains, a comma");
});

test("extraction routes each supported family to the right handling", () => {
  const docx = extractAttachment(
    fixture("sample.docx"),
    describeAttachment("report.docx"),
  );
  assert.equal(docx.ok, true);
  assert.equal(docx.handling, "text");
  assert.match(docx.text, /Quarterly Report/);

  const xlsx = extractAttachment(
    fixture("sample.xlsx"),
    describeAttachment("book.xlsx"),
  );
  assert.equal(xlsx.ok, true);
  assert.match(xlsx.text, /# Sheet: People/);
  assert.match(xlsx.text, /Name\tJoined\tScore\tActive/);
  assert.ok(xlsx.notes.some((note) => note.includes("2 sheets")));

  const code = extractAttachment(
    Buffer.from("package main\n\nfunc main() {}\n", "utf8"),
    describeAttachment("main.go"),
  );
  assert.equal(code.ok, true);
  assert.equal(code.text, "package main\n\nfunc main() {}\n");
});

test("a mislabelled or unreadable file is rejected rather than half-read", () => {
  // A .docx that is not a zip: reported as unreadable, not thrown.
  const notZip = extractAttachment(
    Buffer.from("hello"),
    describeAttachment("fake.docx"),
  );
  assert.equal(notZip.ok, false);
  assert.match(notZip.reason, /Could not read the file/);

  // A .png whose bytes are not a PNG would be sent to a model that cannot decode it.
  const notImage = extractAttachment(
    Buffer.from("still not an image"),
    describeAttachment("fake.png"),
  );
  assert.equal(notImage.ok, false);
  assert.match(notImage.reason, /do not match/);

  const binary = extractAttachment(
    Buffer.from([0x41, 0x00, 0x42]),
    describeAttachment("data.txt"),
  );
  assert.equal(binary.ok, false);
  assert.match(binary.reason, /binary/);

  const empty = extractAttachment(Buffer.from("   \n"), describeAttachment("a.txt"));
  assert.equal(empty.ok, false);
});

test("a real image passes through as bytes rather than text", () => {
  // Smallest valid PNG: signature plus a truncated but well-signed header.
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]);
  const result = extractAttachment(png, describeAttachment("shot.png"));

  assert.equal(result.ok, true);
  assert.equal(result.handling, "image");
  assert.equal(result.text, null);
});

test("CRLF is normalised and a BOM removed so the prompt is not double-spaced", () => {
  const result = extractAttachment(
    Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"),
    describeAttachment("notes.txt"),
  );

  assert.equal(result.text, "one\ntwo\n");
});

test("type detection is by extension, and names the fix for old Office formats", () => {
  assert.equal(describeAttachment("a.png").handling, "image");
  assert.equal(describeAttachment("a.xlsx").handling, "xlsx");
  assert.equal(describeAttachment("a.docx").handling, "docx");
  assert.equal(describeAttachment("a.csv").handling, "text");
  assert.equal(describeAttachment("Main.java").language, "java");
  assert.equal(describeAttachment("deploy.YAML").language, "yaml");
  // An SVG is markup, and is read as text rather than offered to a renderer.
  assert.equal(describeAttachment("logo.svg").handling, "text");

  assert.match(describeAttachment("old.doc").reason, /Save as \.docx/);
  assert.match(describeAttachment("old.xls").reason, /Save as \.xlsx/);
  assert.match(describeAttachment("secrets.pdf").reason, /not supported/);
  assert.equal(describeAttachment("Makefile").supported, false);
  assert.equal(describeAttachment(".gitignore").supported, false);
});

test("upload names are sanitised without losing the extension", () => {
  assert.equal(safeUploadFilename("../../etc/passwd.txt"), "passwd.txt");
  assert.equal(safeUploadFilename("C:\\temp\\my file.md"), "my file.md");
  assert.equal(safeUploadFilename("-rf .bashrc"), "rf .bashrc");
  assert.equal(safeUploadFilename(""), "upload");
  assert.equal(safeUploadFilename("réport.csv"), "r-port.csv");
  // Detection reads the original, so a name that sanitises oddly still types right.
  assert.equal(attachmentExtension("réport.csv"), ".csv");
});

test("the published accept list covers what the user asked to upload", () => {
  const accepted = new Set(acceptedExtensions());
  for (const extension of [
    ".png",
    ".jpg",
    ".md",
    ".xlsx",
    ".csv",
    ".json",
    ".ndjson",
    ".docx",
    ".html",
    ".txt",
    ".c",
    ".java",
    ".yaml",
    ".js",
    ".ts",
    ".go",
  ]) {
    assert.ok(accepted.has(extension), `expected ${extension} to be accepted`);
  }
  assert.ok(!accepted.has(".exe"));
  assert.ok(!accepted.has(".pdf"));
});

test("a message needs words or attachments, and rejects a repeated id", () => {
  const id = "6890f4c2b1a4c3d2e1f00001";
  assert.equal(chatMessageSchema.safeParse({ content: "hi" }).success, true);
  assert.equal(
    chatMessageSchema.safeParse({ content: "", attachmentIds: [id] }).success,
    true,
  );
  assert.equal(chatMessageSchema.safeParse({ content: "   " }).success, false);
  assert.equal(
    chatMessageSchema.safeParse({ content: "", attachmentIds: ["nope"] }).success,
    false,
  );
  const parsed = chatMessageSchema.safeParse({ content: "hi" });
  assert.deepEqual(parsed.data.attachmentIds, []);
});

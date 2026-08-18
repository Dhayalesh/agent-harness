import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNote } from "../Bits.jsx";
import { MarkdownDocument } from "../MarkdownDocument.jsx";
import { decodeArtifact } from "./artifact-utils.js";

export function ArtifactPreview({ kind, mode, bytes, draft }) {
  if (kind === "markdown") {
    const source = draft?.content ?? decodeArtifact(bytes);
    return mode === "code" ? (
      <SourceView source={source} empty="Waiting for Markdown content..." />
    ) : (
      <MarkdownDocument content={source} />
    );
  }
  if (kind === "html") {
    const source = draft?.content ?? decodeArtifact(bytes);
    return mode === "code" ? (
      <SourceView source={source} empty="Waiting for HTML source..." />
    ) : (
      <HtmlPreview source={source} />
    );
  }
  if (kind === "docx") {
    if (draft) {
      return mode === "code" ? (
        <SourceView
          source={draft.content}
          empty="Waiting for document source..."
        />
      ) : (
        <MarkdownDocument content={draft.content ?? ""} />
      );
    }
    return <DocxPreview bytes={bytes} />;
  }
  if (kind === "xlsx") return <WorkbookPreview bytes={bytes} draft={draft} />;
  if (kind === "json" || kind === "code") {
    const source = draft?.content ?? decodeArtifact(bytes);
    return (
      <SourceView
        source={source}
        empty={
          kind === "json" ? "Waiting for JSON content..." : "Waiting for source..."
        }
      />
    );
  }
  if (kind === "ndjson") {
    const source = draft?.content ?? decodeArtifact(bytes);
    return mode === "code" ? (
      <SourceView source={source} empty="Waiting for NDJSON records..." />
    ) : (
      <NdjsonPreview source={source} />
    );
  }
  if (kind === "csv") {
    const source = draft
      ? csvFromDraft(draft)
      : decodeArtifact(bytes).replace(/^\uFEFF/, "");
    return mode === "code" ? (
      <SourceView source={source} empty="Waiting for CSV data..." />
    ) : (
      <CsvPreview source={source} />
    );
  }
  return <SourceView source={decodeArtifact(bytes)} />;
}

function SourceView({ source, empty = "Waiting for content..." }) {
  return (
    <pre className="artifact-source min-h-full whitespace-pre-wrap break-words rounded-large border border-divider bg-content1 p-4 font-mono text-[12px] leading-6 text-foreground shadow-sm">
      {source || empty}
    </pre>
  );
}

function HtmlPreview({ source }) {
  const secured = useMemo(() => secureHtml(source), [source]);
  if (!source) return <EmptyPreview label="Waiting for HTML content" />;
  return (
    <iframe
      title="Sandboxed HTML artifact preview"
      className="min-h-[70vh] w-full rounded-large border border-divider bg-white shadow-sm"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={secured}
    />
  );
}

function secureHtml(source) {
  const policy =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (/<head[\s>]/i.test(source))
    return source.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${source}</body></html>`;
}

function DocxPreview({ bytes }) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const node = host.current;
    if (!node || !bytes) return;
    node.replaceChildren();
    setLoading(true);
    setError(null);
    void import("docx-preview")
      .then(({ renderAsync }) =>
        renderAsync(bytes, node, undefined, {
          className: "docx-page",
          inWrapper: true,
        }),
      )
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      node.replaceChildren();
    };
  }, [bytes]);
  return (
    <div className="artifact-office-preview">
      {loading && <EmptyPreview label="Rendering Word document" />}
      {error && <ErrorNote error={error} />}
      <div
        ref={host}
        className={loading || error ? "hidden" : "docx-preview-host"}
      />
    </div>
  );
}

function WorkbookPreview({ bytes, draft }) {
  const [sheets, setSheets] = useState(() => draftSheets(draft));
  const [active, setActive] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(bytes));
  useEffect(() => {
    if (draft) {
      setSheets(draftSheets(draft));
      setActive(0);
      setLoading(false);
      setError(null);
      return;
    }
    if (!bytes) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void import("exceljs")
      .then(async ({ default: ExcelJS }) => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes);
        return workbook.worksheets.map((sheet) => ({
          name: sheet.name,
          rows: sheet
            .getSheetValues()
            .slice(1)
            .map((row) =>
              Array.isArray(row) ? row.slice(1).map(cellValue) : [],
            ),
        }));
      })
      .then((value) => {
        if (!cancelled) setSheets(value);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, draft]);
  if (loading) return <EmptyPreview label="Reading workbook" />;
  if (error) return <ErrorNote error={error} />;
  if (!sheets.length)
    return <EmptyPreview label="Waiting for spreadsheet data" />;
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div className="artifact-grid-shell">
      <div
        className="artifact-sheet-tabs"
        role="tablist"
        aria-label="Workbook sheets"
      >
        {sheets.map((item, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={active === index}
            key={`${item.name}-${index}`}
            onClick={() => setActive(index)}
          >
            {item.name}
          </button>
        ))}
      </div>
      <DataTable rows={sheet.rows} />
    </div>
  );
}

function CsvPreview({ source }) {
  const rows = useMemo(() => parseCsv(source), [source]);
  return rows.length ? (
    <DataTable rows={rows} />
  ) : (
    <EmptyPreview label="Waiting for CSV data" />
  );
}

/**
 * NDJSON as a table, since one record per line is nearly always a dataset.
 *
 * Columns are the union of keys in file order rather than the first record's keys,
 * so a field that only some records carry still gets a column. A line that has not
 * finished streaming is skipped instead of failing the whole view.
 */
function NdjsonPreview({ source }) {
  const rows = useMemo(() => {
    const records = [];
    const columns = [];
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : { value };
      for (const key of Object.keys(record)) {
        if (!columns.includes(key)) columns.push(key);
      }
      records.push(record);
    }
    if (!records.length) return [];
    return [
      columns,
      ...records.map((record) =>
        columns.map((key) =>
          key in record ? scalarText(record[key]) : "",
        ),
      ),
    ];
  }, [source]);
  return rows.length ? (
    <DataTable rows={rows} />
  ) : (
    <EmptyPreview label="Waiting for NDJSON records" />
  );
}

function scalarText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function DataTable({ rows }) {
  const visible = rows.slice(0, 500);
  const width = Math.min(200, Math.max(0, ...visible.map((row) => row.length)));
  return (
    <div className="artifact-table-wrap">
      <table className="artifact-table">
        <thead>
          <tr>
            {Array.from({ length: width }, (_, index) => (
              <th key={index}>
                {visible[0]?.[index] ?? `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.slice(1).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: width }, (_, index) => (
                <td key={index}>{String(row[index] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > visible.length && (
        <p className="artifact-row-limit">
          Showing the first {visible.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

function draftSheets(draft) {
  return (draft?.sheets ?? []).map((sheet) => ({
    name: sheet.name || "Sheet",
    rows: [sheet.columns ?? [], ...(sheet.rows ?? [])],
  }));
}

function cellValue(value) {
  if (value && typeof value === "object")
    return (
      value.text ??
      value.result ??
      value.richText?.map((part) => part.text).join("") ??
      JSON.stringify(value)
    );
  return value ?? "";
}

function csvFromDraft(draft) {
  return [draft?.columns ?? [], ...(draft?.rows ?? [])]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(source) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '"' && source[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function EmptyPreview({ label }) {
  return (
    <div
      className="grid min-h-64 place-items-center text-small text-default-500"
      role="status"
    >
      {label}...
    </div>
  );
}

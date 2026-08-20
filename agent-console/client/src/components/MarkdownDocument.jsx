import { Fragment } from "react";

/** A safe, dependency-free Markdown preview for persisted response documents. */
export function MarkdownDocument({ content, className = "" }) {
  return (
    <div className={`markdown-document ${className}`.trimEnd()}>
      {blocks(String(content ?? ""))}
    </div>
  );
}

function blocks(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith("```")
      ) {
        code.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      output.push(
        <div className="markdown-code" key={`code-${index}`}>
          {language && <span>{language}</span>}
          <pre>
            <code>{code.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Heading = `h${level}`;
      output.push(
        <Heading key={`heading-${index}`}>{inline(heading[2])}</Heading>,
      );
      index += 1;
      continue;
    }

    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      output.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    if (isTable(lines, index)) {
      const headers = cells(lines[index]);
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim()
      ) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      output.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{inline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const list = /^(\s*)([-*+] |\d+\. )(.+)$/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2][0]);
      const items = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*+] |\d+\. )(.+)$/.exec(lines[index]);
        if (!item || /\d/.test(item[2][0]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      output.push(
        <List key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(
        <blockquote key={`quote-${index}`}>
          {inline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(
      <p key={`paragraph-${index}`}>{inline(paragraph.join(" "))}</p>,
    );
  }
  return output;
}

function startsBlock(lines, index) {
  const line = lines[index];
  return (
    /^(#{1,6})\s+/.test(line) ||
    line.trimStart().startsWith("```") ||
    /^(\s*)([-*+] |\d+\. )/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(---+|___+|\*\*\*+)\s*$/.test(line) ||
    isTable(lines, index)
  );
}

function isTable(lines, index) {
  return (
    lines[index]?.includes("|") &&
    /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")
  );
}

function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((value) => value.trim());
}

function inline(value) {
  const pattern =
    /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  return String(value)
    .split(pattern)
    .filter(Boolean)
    .map((part, index) => {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (link)
        return (
          <a href={link[2]} target="_blank" rel="noreferrer" key={index}>
            {link[1]}
          </a>
        );
      if (part.startsWith("`") && part.endsWith("`"))
        return <code key={index}>{part.slice(1, -1)}</code>;
      if (
        (part.startsWith("**") && part.endsWith("**")) ||
        (part.startsWith("__") && part.endsWith("__"))
      )
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (
        (part.startsWith("*") && part.endsWith("*")) ||
        (part.startsWith("_") && part.endsWith("_"))
      )
        return <em key={index}>{part.slice(1, -1)}</em>;
      return <Fragment key={index}>{part}</Fragment>;
    });
}

const MAX_TOOL_CALLS = 50;
const MAX_INPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 40_000;
const ARTIFACT_TOOL_KINDS = {
  create_markdown_artifact: "Markdown",
  create_html_artifact: "HTML",
  create_document_artifact: "Word",
  create_spreadsheet_artifact: "Excel",
  create_csv_artifact: "CSV",
};

/** Adds current-turn tool detail to a buffered runtime result. */
export function hydrateRuntimeToolCalls(result) {
  return {
    ...result,
    toolCalls: toolCallsFromMessages(result?.messages),
  };
}

/** Correlates tool calls/results after the latest user prompt. */
export function toolCallsFromMessages(messages) {
  const all = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (
      all[index]?.role === "user" &&
      (all[index]?.content ?? []).some((block) => block?.type === "text")
    ) {
      start = index;
      break;
    }
  }

  const calls = new Map();
  for (const message of all.slice(start)) {
    for (const block of Array.isArray(message?.content)
      ? message.content
      : []) {
      if (block?.type === "tool_call" && typeof block.id === "string") {
        if (calls.size >= MAX_TOOL_CALLS && !calls.has(block.id)) continue;
        calls.set(
          block.id,
          presentedToolCall({
            id: block.id,
            name: block.name,
            input: block.input,
            status: "running",
          }),
        );
      }
      if (
        block?.type === "tool_result" &&
        typeof block.toolCallId === "string"
      ) {
        const call = calls.get(block.toolCallId);
        if (!call) continue;
        calls.set(
          block.toolCallId,
          presentedToolCall({
            ...call,
            output: block.content,
            isError: block.isError === true,
            status: block.isError ? "error" : "done",
          }),
        );
      }
    }
  }
  return [...calls.values()];
}

/** Normalizes one stream-folded call into the same bounded persisted shape. */
export function presentedToolCall(call) {
  const name = clean(call?.name, 200) || "tool";
  return {
    id: clean(call?.id, 300) || `tool-${Date.now()}`,
    name,
    input: inputText(name, call?.input),
    output: outputText(call?.output),
    status: ["pending", "running", "done", "error"].includes(call?.status)
      ? call.status
      : call?.isError
        ? "error"
        : "done",
  };
}

function inputText(name, input) {
  const parsed = parseInput(input);
  if (ARTIFACT_TOOL_KINDS[name] && parsed) {
    // Generated-file bytes belong only in S3. History retains intent and shape,
    // never a second copy of document contents or thousands of cells.
    const summary = {
      title: parsed.title,
      filename: parsed.filename,
    };
    if ("content" in parsed) {
      summary.content = `[saved as ${ARTIFACT_TOOL_KINDS[name]} artifact]`;
    }
    if (Array.isArray(parsed.columns)) {
      summary.columns = parsed.columns;
      summary.rows = `[${Array.isArray(parsed.rows) ? parsed.rows.length : 0} rows saved as ${ARTIFACT_TOOL_KINDS[name]} artifact]`;
    }
    if (Array.isArray(parsed.sheets)) {
      summary.sheets = parsed.sheets.map((sheet) => ({
        name: sheet?.name,
        columns: Array.isArray(sheet?.columns) ? sheet.columns : [],
        rows: Array.isArray(sheet?.rows) ? sheet.rows.length : 0,
      }));
    }
    return bounded(JSON.stringify(summary, null, 2), MAX_INPUT_CHARS);
  }
  if (typeof input === "string") return bounded(input, MAX_INPUT_CHARS);
  try {
    return bounded(JSON.stringify(input ?? {}, null, 2), MAX_INPUT_CHARS);
  } catch {
    return "[unserializable input]";
  }
}

function outputText(output) {
  if (Array.isArray(output))
    return bounded(output.join("\n"), MAX_OUTPUT_CHARS);
  if (typeof output === "string") return bounded(output, MAX_OUTPUT_CHARS);
  if (output === undefined || output === null) return "";
  try {
    return bounded(JSON.stringify(output, null, 2), MAX_OUTPUT_CHARS);
  } catch {
    return "[unserializable output]";
  }
}

function parseInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (typeof input !== "string") return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function bounded(value, maximum) {
  const text = String(value ?? "");
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum)}\n… output truncated`;
}

function clean(value, maximum) {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1F\x7F]/g, " ")
        .trim()
        .slice(0, maximum)
    : "";
}

/**
 * Quote-aware shell command decomposition.
 *
 * Ported from `claude-code/src/tools/BashTool/commandSemantics.ts` and
 * `utils/bash/commands.ts`, minus the tree-sitter and `shell-quote`
 * dependencies: this implementation is a hand-rolled scanner so the harness
 * stays dependency-free. It is deliberately conservative — anything it cannot
 * parse confidently is reported as unparsed so callers fall back to asking the
 * user rather than auto-approving.
 */

/** Wrapper commands that prefix a real command without changing its effect. */
const SAFE_WRAPPERS = new Set([
  'time',
  'timeout',
  'nice',
  'nohup',
  'stdbuf',
  'command',
  'builtin',
  'env',
]);

/** Flags consumed by wrapper commands, so the real base command is found. */
const WRAPPER_FLAG_PATTERN = /^(-|--)/;

/**
 * Characters where a preceding backslash is a shell escape. Anything else keeps
 * the backslash, so Windows paths (`C:\Users\me`) survive tokenization. Dropping
 * it would be both wrong on win32 and unsafe: `cat C:\Users\x\.ssh\id_rsa` would
 * flatten to a single token that no path or secret-file check can recognise.
 */
const ESCAPABLE = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '"',
  "'",
  '\\',
  '$',
  '`',
  '|',
  '&',
  ';',
  '(',
  ')',
  '<',
  '>',
  '*',
  '?',
  '#',
  '!',
  '~',
]);

export type CommandSegment = {
  /** Raw text of this segment, trimmed. */
  text: string;
  /** Quote-aware tokens. Empty when the segment could not be tokenized. */
  tokens: string[];
  /** First token after env assignments and safe wrappers are stripped. */
  baseCommand: string;
  /** Tokens following `baseCommand`. */
  args: string[];
};

export type ParsedCommand = {
  segments: CommandSegment[];
  /** True when quoting was unbalanced, so tokens cannot be trusted. */
  unparsed: boolean;
  /** Every operator joining the segments, in order. */
  operators: string[];
};

export type Redirection = {
  operator: '>' | '>>';
  target: string;
};

type Scan = {
  tokens: string[];
  unterminated: boolean;
};

/**
 * Tokenizes a single command segment, honouring single quotes, double quotes,
 * and backslash escapes. Quote characters are removed; their contents are not
 * interpreted.
 */
export function tokenize(command: string): string[] {
  return scan(command).tokens;
}

function scan(command: string): Scan {
  const tokens: string[] = [];
  const characters = [...command];
  let current = '';
  let hasCurrent = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const char = characters[index] as string;
    if (escaped) {
      current += char;
      hasCurrent = true;
      escaped = false;
      continue;
    }
    if (char === '\\' && !inSingle) {
      const next = characters[index + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        escaped = true;
        hasCurrent = true;
        continue;
      }
      // Not a meaningful escape: keep the backslash as a literal character.
      current += char;
      hasCurrent = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      hasCurrent = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      hasCurrent = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (hasCurrent) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (hasCurrent) tokens.push(current);
  return { tokens, unterminated: inSingle || inDouble || escaped };
}

/**
 * Splits a compound command on `;`, `&&`, `||`, `|`, `&`, and newlines while
 * respecting quotes, subshells, and command substitution boundaries.
 */
export function splitCommandSegments(command: string): {
  segments: string[];
  operators: string[];
  unparsed: boolean;
} {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let depth = 0;

  const push = (): void => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (inSingle || inDouble) {
      current += char;
      continue;
    }
    if (char === '(' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth > 0) {
      current += char;
      continue;
    }

    if (char === '\n' || char === '\r') {
      push();
      operators.push('\n');
      continue;
    }
    // `2>&1` and `&>log` are redirections, not command separators. Splitting on
    // the `&` would leave a bogus `1` segment and hide the real command.
    if (char === '&' && (current.trimEnd().endsWith('>') || next === '>')) {
      current += char;
      continue;
    }
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      push();
      operators.push(char + char);
      index += 1;
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      push();
      operators.push(char);
      continue;
    }
    current += char;
  }
  push();
  return { segments, operators, unparsed: inSingle || inDouble || escaped || depth > 0 };
}

/** Removes wrapper commands and leading `VAR=value` assignments. */
export function stripSafeWrappers(tokens: readonly string[]): string[] {
  let result = [...tokens];
  // Leading environment assignments: FOO=bar cmd
  while (result.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0] as string)) {
    result = result.slice(1);
  }
  while (result.length > 0 && SAFE_WRAPPERS.has(result[0] as string)) {
    result = result.slice(1);
    // Drop the wrapper's own flags and their values (e.g. `timeout -s TERM 5`).
    while (result.length > 0 && WRAPPER_FLAG_PATTERN.test(result[0] as string)) {
      result = result.slice(1);
    }
    // `timeout 5 cmd` / `nice 10 cmd`: drop a bare duration/priority argument.
    if (result.length > 1 && /^\d+(\.\d+)?[smhd]?$/.test(result[0] as string)) {
      result = result.slice(1);
    }
    while (result.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(result[0] as string)) {
      result = result.slice(1);
    }
  }
  return result;
}

export function parseCommand(command: string): ParsedCommand {
  const split = splitCommandSegments(command);
  let unparsed = split.unparsed;
  const segments: CommandSegment[] = split.segments.map((text) => {
    const scanned = scan(text);
    if (scanned.unterminated) unparsed = true;
    const stripped = stripSafeWrappers(scanned.tokens);
    const withoutRedirections = dropRedirectionTokens(stripped);
    const [baseCommand = '', ...args] = withoutRedirections;
    return { text, tokens: scanned.tokens, baseCommand, args };
  });
  return { segments, unparsed, operators: split.operators };
}

/** Drops `>file`, `2>&1`, `<file` and friends so they are not read as args. */
function dropRedirectionTokens(tokens: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (/^[0-9]*(>>|>|<)/.test(token)) {
      // `>out.txt` carries its target; a bare `>` consumes the next token.
      if (/^[0-9]*(>>|>|<)$/.test(token)) index += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

/**
 * Extracts output redirection targets. `2>&1` and `>/dev/null` are recognised
 * but not reported, matching `stripSafeRedirections` in claude-code.
 */
export function extractOutputRedirections(command: string): Redirection[] {
  const redirections: Redirection[] = [];
  const scanned = scan(command);
  const tokens = scanned.tokens;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const match = /^([0-9]*)(>>|>)(.*)$/.exec(token);
    if (!match) continue;
    const operator = match[2] === '>>' ? '>>' : '>';
    let target = match[3] ?? '';
    if (target === '') {
      const nextToken = tokens[index + 1];
      if (nextToken === undefined) continue;
      target = nextToken;
      index += 1;
    }
    if (target.startsWith('&')) continue; // fd duplication such as 2>&1
    if (target === '/dev/null' || target === 'NUL' || target === 'nul') continue;
    redirections.push({ operator, target });
  }
  return redirections;
}

/** True when any segment of the command is `cd`. */
export function containsDirectoryChange(parsed: ParsedCommand): boolean {
  return parsed.segments.some((segment) => segment.baseCommand === 'cd');
}

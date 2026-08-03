/**
 * Injection detection and read-only classification for PowerShell.
 *
 * Ported from `claude-code/src/tools/PowerShellTool/powershellSecurity.ts`,
 * `commandSemantics.ts`, and `gitSafety.ts`. PowerShell needs its own layer
 * rather than reusing the bash one: the metacharacters differ, the call operator
 * (`&`) and `Invoke-Expression` are the primary injection vectors, and cmdlet
 * naming means the read-only allowlist works on verbs rather than binaries.
 */

import type { ShellFinding } from './findings.js';

/** Cmdlet verbs that only observe state. */
const READ_ONLY_VERBS = new Set([
  'get',
  'measure',
  'select',
  'sort',
  'compare',
  'test',
  'resolve',
  'split',
  'join',
  'convertfrom',
  'convertto',
  'format',
  'out',
  'where',
  'foreach',
  'group',
  'show',
]);

/**
 * Read-only cmdlets that do not follow the verb rule, plus aliases for common
 * read-only binaries.
 */
const READ_ONLY_COMMANDS = new Set([
  'echo',
  'write-output',
  'write-host',
  'gc',
  'cat',
  'type',
  'gci',
  'ls',
  'dir',
  'gcm',
  'gm',
  'gp',
  'gps',
  'ps',
  'pwd',
  'gl',
  'sls',
  'select-string',
  'findstr',
  'more',
  'tree',
  'whoami',
  'hostname',
  'git',
  'rg',
  'node',
  'npm',
]);

/**
 * Cmdlets and operators that execute arbitrary text. These are the PowerShell
 * equivalent of `$()` in bash: no name-based inspection can see through them.
 */
const EXECUTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string; message: string }> = [
  {
    pattern: /\b(Invoke-Expression|iex)\b/i,
    code: 'INVOKE_EXPRESSION',
    message: 'Invoke-Expression executes arbitrary text as code',
  },
  {
    pattern: /-Enc(o(d(e(d(C(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?\b/i,
    code: 'ENCODED_COMMAND',
    message: '-EncodedCommand hides the command payload behind base64',
  },
  {
    pattern: /\[(System\.)?(Text\.)?Encoding\]::/i,
    code: 'ENCODING_DECODE',
    message: 'inline encoding conversion can hide a command payload',
  },
  {
    pattern: /\[(System\.)?Convert\]::FromBase64String/i,
    code: 'BASE64_DECODE',
    message: 'base64 decoding can hide a command payload',
  },
  {
    pattern: /\bDownloadString\b|\bDownloadFile\b/i,
    code: 'WEBCLIENT_DOWNLOAD',
    message: 'WebClient download combined with execution runs unreviewed remote code',
  },
  {
    pattern: /\bAdd-Type\b/i,
    code: 'ADD_TYPE',
    message: 'Add-Type compiles and loads arbitrary code',
  },
  {
    pattern: /\bStart-Process\b/i,
    code: 'START_PROCESS',
    message: 'Start-Process launches a detached process outside the captured session',
  },
  {
    pattern: /\bInvoke-Command\b/i,
    code: 'INVOKE_COMMAND',
    message: 'Invoke-Command can execute on remote machines',
  },
  {
    pattern: /\bNew-Object\s+System\.Net\./i,
    code: 'NET_OBJECT',
    message: 'direct System.Net object construction can open network connections',
  },
  {
    pattern: /\$ExecutionContext|\$MyInvocation|\[scriptblock\]::Create/i,
    code: 'SCRIPTBLOCK_CREATE',
    message: 'dynamic scriptblock creation executes generated code',
  },
];

/** Remote fetch cmdlets, used to detect fetch-then-execute chains. */
const FETCH_PATTERN = /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)\b/i;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNICODE_WHITESPACE =
  /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u180e\u200b-\u200d\ufeff]/;

export type PowerShellInspection = {
  findings: ShellFinding[];
  /** Pipeline stages, split on `|` and `;` outside quotes. */
  stages: string[];
};

export function inspectPowerShellCommand(command: string): PowerShellInspection {
  const stages = splitPipeline(command);
  const findings: ShellFinding[] = [];
  if (!command.trim()) return { findings, stages };

  if (CONTROL_CHARACTERS.test(command)) {
    findings.push({
      severity: 'block',
      code: 'CONTROL_CHARACTERS',
      message: 'Command contains control characters',
    });
  }
  if (UNICODE_WHITESPACE.test(command)) {
    findings.push({
      severity: 'block',
      code: 'UNICODE_WHITESPACE',
      message: 'Command contains Unicode whitespace that is invisible in a terminal',
    });
  }

  for (const { pattern, code, message } of EXECUTION_PATTERNS) {
    if (pattern.test(command)) {
      findings.push({ severity: 'ask', code, message });
    }
  }

  // Fetch piped into an executor is the PowerShell analogue of `curl | sh`.
  if (FETCH_PATTERN.test(command) && /\|\s*(iex|Invoke-Expression)\b/i.test(command)) {
    findings.push({
      severity: 'block',
      code: 'FETCH_TO_INVOKE_EXPRESSION',
      message: 'Remote content is piped into Invoke-Expression, executing unreviewed remote code',
    });
  }

  // The call operator applied to a variable or string resolves at runtime.
  if (/(^|[\s;|(])&\s*[$"']/.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'CALL_OPERATOR',
      message: 'the & call operator invokes a command name computed at runtime',
    });
  }

  if (/\$\(/.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'SUBEXPRESSION',
      message: '$() subexpression evaluates embedded code',
    });
  }

  if (/\b(Set|New|Remove|Clear)-Item(Property)?\b[^;\n|]*HK(LM|CU|CR|U|CC):/i.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'REGISTRY_WRITE',
      message: 'Command modifies the Windows registry',
    });
  }

  if (/\bSet-ExecutionPolicy\b/i.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'EXECUTION_POLICY',
      message: 'Command changes the PowerShell execution policy',
    });
  }

  if (/-ErrorAction\s+SilentlyContinue\b/i.test(command) && /\bRemove-/i.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'SILENT_REMOVAL',
      message: 'Removal with -ErrorAction SilentlyContinue hides failures',
    });
  }

  return { findings, stages };
}

export type PowerShellReadOnlyAssessment = {
  readOnly: boolean;
  reason?: string;
};

export function assessPowerShellReadOnly(
  command: string,
  stages: readonly string[],
): PowerShellReadOnlyAssessment {
  if (stages.length === 0) return { readOnly: false, reason: 'no command found' };
  if (
    /(^|[^>])>{1,2}[^>]/.test(command) ||
    /\b(Out-File|Set-Content|Add-Content|Tee-Object)\b/i.test(command)
  ) {
    return { readOnly: false, reason: 'command writes output to a file' };
  }
  for (const stage of stages) {
    const name = firstToken(stage);
    if (name === '') return { readOnly: false, reason: 'empty pipeline stage' };
    const lower = name.toLowerCase();
    if (READ_ONLY_COMMANDS.has(lower)) {
      if (lower === 'git' && !isReadOnlyGitStage(stage)) {
        return { readOnly: false, reason: 'git subcommand is not read-only' };
      }
      if ((lower === 'npm' || lower === 'node') && /\b(run|exec|install|-e|--eval)\b/.test(stage)) {
        return { readOnly: false, reason: `'${lower}' is executing project code` };
      }
      continue;
    }
    const verb = lower.split('-')[0];
    if (verb !== undefined && lower.includes('-') && READ_ONLY_VERBS.has(verb)) {
      // Get-Content -OutVariable is still read-only; Get-Credential prompts.
      continue;
    }
    return { readOnly: false, reason: `'${name}' is not a known read-only command` };
  }
  return { readOnly: true };
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'branch',
  'tag',
  'remote',
  'describe',
  'shortlog',
  'reflog',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'cat-file',
  'rev-parse',
  'rev-list',
  'for-each-ref',
  'merge-base',
  'grep',
]);

function isReadOnlyGitStage(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/).slice(1);
  const subcommand = tokens.find((token) => !token.startsWith('-'));
  return subcommand !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/** Splits on `|` and `;` outside quotes, subexpressions, and script blocks. */
export function splitPipeline(command: string): string[] {
  const stages: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let depth = 0;

  const push = (): void => {
    if (current.trim()) stages.push(current.trim());
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (char === '`') {
      // PowerShell escape character: consume the next character verbatim.
      current += char;
      const next = command[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
      }
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
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth === 0 && (char === '|' || char === ';' || char === '\n')) {
      push();
      continue;
    }
    current += char;
  }
  push();
  return stages;
}

function firstToken(stage: string): string {
  const match = /^\s*([^\s(]+)/.exec(stage);
  return match?.[1] ?? '';
}

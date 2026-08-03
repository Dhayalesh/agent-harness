/**
 * Injection and obfuscation detection for bash-style commands.
 *
 * Ported from `claude-code/src/tools/BashTool/bashSecurity.ts`. The upstream
 * file runs ~30 validators and depends on tree-sitter plus analytics; this port
 * keeps the checks that are meaningful without a shell parser and drops the ones
 * that exist purely to harden claude-code's own allowlist matching.
 *
 * The contract is inverted relative to upstream for clarity: upstream returns
 * "safe/unsafe" verdicts, this returns findings. No findings means nothing
 * suspicious was detected — which is not the same as "auto-approve". Approval is
 * the caller's decision (see `bash.ts` `checkPermissions`).
 */

import { parseCommand, type ParsedCommand } from './command-semantics.js';
import type { ShellFinding } from './findings.js';

/**
 * Constructs that let one command smuggle another past name-based inspection.
 * Upstream treats all of these as "needs validation"; we surface them as `ask`
 * so a human sees the command, rather than blocking legitimate shell use.
 */
const SUBSTITUTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string; message: string }> = [
  { pattern: /\$\(/, code: 'COMMAND_SUBSTITUTION', message: '$() command substitution' },
  { pattern: /<\(/, code: 'PROCESS_SUBSTITUTION_IN', message: 'process substitution <()' },
  { pattern: />\(/, code: 'PROCESS_SUBSTITUTION_OUT', message: 'process substitution >()' },
  { pattern: /=\(/, code: 'ZSH_PROCESS_SUBSTITUTION', message: 'zsh process substitution =()' },
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    code: 'ZSH_EQUALS_EXPANSION',
    message: 'zsh equals expansion (=cmd) resolves to an arbitrary binary path',
  },
  { pattern: /\$\{/, code: 'PARAMETER_EXPANSION', message: '${} parameter expansion' },
  { pattern: /\$\[/, code: 'LEGACY_ARITHMETIC', message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, code: 'ZSH_PARAMETER_EXPANSION', message: 'zsh-style parameter expansion' },
  { pattern: /\(e:/, code: 'ZSH_GLOB_QUALIFIER', message: 'zsh glob qualifier with execution' },
  { pattern: /\(\+/, code: 'ZSH_GLOB_FUNCTION', message: 'zsh glob qualifier with execution' },
  {
    pattern: /\}\s*always\s*\{/,
    code: 'ZSH_ALWAYS_BLOCK',
    message: 'zsh always block (try/always construct)',
  },
  { pattern: /<#/, code: 'POWERSHELL_COMMENT', message: 'PowerShell comment syntax' },
];

/**
 * Zsh builtins and modules that reach the filesystem or network without going
 * through a binary, so command-name inspection cannot see them.
 * Verbatim from upstream `ZSH_DANGEROUS_COMMANDS`.
 */
const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'mapfile',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
]);

/** Commands that execute whatever arrives on stdin. */
const STDIN_EXECUTORS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'node',
  'php',
]);

/** Commands that fetch from the network. */
const NETWORK_FETCHERS = new Set(['curl', 'wget', 'fetch', 'httpie', 'http']);

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Whitespace that is invisible in a terminal but not a shell separator. */
const UNICODE_WHITESPACE =
  /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u180e\u200b-\u200d\ufeff]/;

export type BashInspection = {
  findings: ShellFinding[];
  parsed: ParsedCommand;
};

export function inspectBashCommand(command: string): BashInspection {
  const parsed = parseCommand(command);
  const findings: ShellFinding[] = [];

  if (!command.trim()) {
    return { findings, parsed };
  }

  if (parsed.unparsed) {
    findings.push({
      severity: 'ask',
      code: 'UNBALANCED_QUOTING',
      message: 'Command has unbalanced quotes, escapes, or brackets and cannot be analysed',
    });
  }

  findings.push(...inspectFragments(command));
  findings.push(...inspectSubstitutions(command));
  findings.push(...inspectObfuscation(command));
  findings.push(...inspectZshCommands(parsed));
  findings.push(...inspectPipeToInterpreter(parsed));
  findings.push(...inspectEnvironmentExfiltration(command, parsed));

  return { findings, parsed };
}

/** Upstream `validateIncompleteCommands`. */
function inspectFragments(command: string): ShellFinding[] {
  const trimmed = command.trim();
  if (/^\s*\t/.test(command)) {
    return [
      {
        severity: 'ask',
        code: 'INCOMPLETE_FRAGMENT',
        message: 'Command appears to be an incomplete fragment (starts with a tab)',
      },
    ];
  }
  if (trimmed.startsWith('-')) {
    return [
      {
        severity: 'ask',
        code: 'INCOMPLETE_FRAGMENT',
        message: 'Command appears to be an incomplete fragment (starts with flags)',
      },
    ];
  }
  if (/^\s*(&&|\|\||;|>>?|<)/.test(command)) {
    return [
      {
        severity: 'ask',
        code: 'CONTINUATION_LINE',
        message: 'Command appears to be a continuation line (starts with an operator)',
      },
    ];
  }
  return [];
}

function inspectSubstitutions(command: string): ShellFinding[] {
  const findings: ShellFinding[] = [];
  const unquoted = stripQuotedContent(command);

  for (const { pattern, code, message } of SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquoted)) {
      findings.push({ severity: 'ask', code, message });
    }
  }
  if (hasUnescapedChar(unquoted, '`')) {
    findings.push({
      severity: 'ask',
      code: 'BACKTICK_SUBSTITUTION',
      message: 'backtick command substitution',
    });
  }
  return findings;
}

function inspectObfuscation(command: string): ShellFinding[] {
  const findings: ShellFinding[] = [];
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
  if (/\bIFS\s*=/.test(command)) {
    findings.push({
      severity: 'ask',
      code: 'IFS_INJECTION',
      message: 'Command reassigns IFS, which changes how later arguments are split',
    });
  }
  return findings;
}

function inspectZshCommands(parsed: ParsedCommand): ShellFinding[] {
  const findings: ShellFinding[] = [];
  for (const segment of parsed.segments) {
    if (ZSH_DANGEROUS_COMMANDS.has(segment.baseCommand)) {
      findings.push({
        severity: 'block',
        code: 'ZSH_DANGEROUS_COMMAND',
        message: `'${segment.baseCommand}' can read, write, or transmit data without invoking a binary`,
      });
    }
  }
  return findings;
}

/** `curl … | sh` and relatives: remote code with no reviewable payload. */
function inspectPipeToInterpreter(parsed: ParsedCommand): ShellFinding[] {
  const findings: ShellFinding[] = [];
  const { segments, operators } = parsed;

  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (operators[index] !== '|') continue;
    const producer = segments[index];
    const consumer = segments[index + 1];
    if (!producer || !consumer) continue;
    if (!NETWORK_FETCHERS.has(producer.baseCommand)) continue;
    if (!STDIN_EXECUTORS.has(consumer.baseCommand)) continue;
    findings.push({
      severity: 'block',
      code: 'PIPE_TO_INTERPRETER',
      message: `'${producer.baseCommand}' output is piped into '${consumer.baseCommand}', executing unreviewed remote code`,
    });
  }
  return findings;
}

/** Upstream `validateProcEnvironAccess`, generalised to secret-bearing files. */
function inspectEnvironmentExfiltration(command: string, parsed: ParsedCommand): ShellFinding[] {
  const findings: ShellFinding[] = [];
  if (/\/proc\/(self|\d+|\$\$)\/environ/.test(command)) {
    findings.push({
      severity: 'block',
      code: 'PROC_ENVIRON_ACCESS',
      message: 'Command reads /proc/<pid>/environ, which exposes the process environment',
    });
  }
  const readsEnvFile = parsed.segments.some((segment) =>
    segment.args.some((arg) => /(^|[\\/])\.env(\.|$)|(^|[\\/])(id_rsa|id_ed25519)$/.test(arg)),
  );
  if (readsEnvFile) {
    findings.push({
      severity: 'ask',
      code: 'SECRET_FILE_ACCESS',
      message: 'Command references a credential file (.env or a private key)',
    });
  }
  return findings;
}

/**
 * Removes quoted spans so pattern matching sees only shell-active text.
 * Port of upstream `extractQuotedContent().fullyUnquoted`.
 */
export function stripQuotedContent(command: string): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      escaped = false;
      if (!inSingle && !inDouble) result += char;
      continue;
    }
    if (char === '\\' && !inSingle) {
      escaped = true;
      if (!inSingle && !inDouble) result += char;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble) result += char;
  }
  return result;
}

/**
 * Port of upstream `hasUnescapedChar`. Single characters only — the upstream
 * comment about ANSI-C quoting ($'\n') applies here too.
 */
export function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) throw new Error('hasUnescapedChar only works with single characters');
  let index = 0;
  while (index < content.length) {
    if (content[index] === '\\' && index + 1 < content.length) {
      index += 2;
      continue;
    }
    if (content[index] === char) return true;
    index += 1;
  }
  return false;
}

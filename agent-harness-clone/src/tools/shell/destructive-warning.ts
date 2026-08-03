/**
 * Detects potentially destructive commands and returns a warning string for
 * display in the permission prompt. Purely informational — it never affects the
 * permission decision or auto-approval.
 *
 * Ported from `claude-code/src/tools/BashTool/destructiveCommandWarning.ts` and
 * `PowerShellTool/destructiveCommandWarning.ts`, with the git patterns shared
 * between both shells and a small set of SAP/BTP additions.
 */

type DestructivePattern = {
  pattern: RegExp;
  warning: string;
};

/** Applies to any shell: git and SQL syntax do not change per shell. */
const SHARED_PATTERNS: readonly DestructivePattern[] = [
  // Git — data loss / hard to reverse
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: 'Note: may discard uncommitted changes' },
  {
    pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/,
    warning: 'Note: may overwrite remote history',
  },
  {
    pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/,
    warning: 'Note: may permanently delete untracked files',
  },
  {
    pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/,
    warning: 'Note: may discard all working tree changes',
  },
  {
    pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/,
    warning: 'Note: may permanently remove stashed changes',
  },
  {
    pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force|--force\s+--delete)\b/,
    warning: 'Note: may force-delete a branch',
  },

  // Git — safety bypass
  {
    pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/,
    warning: 'Note: may skip safety hooks',
  },
  { pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, warning: 'Note: may rewrite the last commit' },

  // Database
  {
    pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i,
    warning: 'Note: may drop or truncate database objects',
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i,
    warning: 'Note: may delete all rows from a database table',
  },

  // Infrastructure
  { pattern: /\bkubectl\s+delete\b/, warning: 'Note: may delete Kubernetes resources' },
  { pattern: /\bterraform\s+destroy\b/, warning: 'Note: may destroy Terraform infrastructure' },
  {
    pattern: /\bcf\s+delete(-service|-space|-org)?\b/,
    warning: 'Note: may delete Cloud Foundry resources',
  },
  {
    pattern: /\bbtp\s+(delete|unsubscribe)\b/,
    warning: 'Note: may delete or unsubscribe SAP BTP resources',
  },
  { pattern: /\bcds\s+deploy\b[^;&|\n]*--to\s+hana\b/, warning: 'Note: may alter HANA schema' },
];

const BASH_PATTERNS: readonly DestructivePattern[] = [
  {
    pattern:
      /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively force-remove files',
  },
  {
    pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/,
    warning: 'Note: may recursively remove files',
  },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/, warning: 'Note: may force-remove files' },
  { pattern: /\b(mkfs|dd\s+if=[^;&|\n]*of=\/dev\/)/, warning: 'Note: may overwrite a raw device' },
  { pattern: /\bchmod\s+-R\s+777\b/, warning: 'Note: may grant world-writable permissions' },
];

const POWERSHELL_PATTERNS: readonly DestructivePattern[] = [
  {
    pattern:
      /\bRemove-Item\b[^;\n|]*-Recurse\b[^;\n|]*-Force\b|\bRemove-Item\b[^;\n|]*-Force\b[^;\n|]*-Recurse\b/i,
    warning: 'Note: may recursively force-remove files',
  },
  { pattern: /\bRemove-Item\b[^;\n|]*-Recurse\b/i, warning: 'Note: may recursively remove files' },
  {
    pattern: /\b(ri|rd|rmdir|del|erase)\b\s+[^;\n|]*\/s\b/i,
    warning: 'Note: may remove a directory tree',
  },
  { pattern: /\bFormat-Volume\b/i, warning: 'Note: may format a volume' },
  { pattern: /\bClear-Disk\b/i, warning: 'Note: may erase a disk' },
  { pattern: /\bRemove-Item\b[^;\n|]*HK(LM|CU):/i, warning: 'Note: may delete registry keys' },
  { pattern: /\bSet-ExecutionPolicy\b/i, warning: 'Note: may weaken script execution policy' },
  {
    pattern: /\b(Stop-Computer|Restart-Computer)\b/i,
    warning: 'Note: may shut down or reboot the machine',
  },
  { pattern: /\bStop-Process\b[^;\n|]*-Force\b/i, warning: 'Note: may force-kill processes' },
];

export type ShellFlavor = 'bash' | 'powershell';

/**
 * Returns a human-readable warning for the first destructive pattern matched, or
 * `null` when none match.
 */
export function getDestructiveCommandWarning(
  command: string,
  flavor: ShellFlavor = 'bash',
): string | null {
  const patterns = [
    ...SHARED_PATTERNS,
    ...(flavor === 'powershell' ? POWERSHELL_PATTERNS : BASH_PATTERNS),
  ];
  for (const { pattern, warning } of patterns) {
    if (pattern.test(command)) return warning;
  }
  return null;
}

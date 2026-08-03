/**
 * Path extraction and workspace boundary enforcement for shell commands.
 *
 * Ported from `claude-code/src/tools/BashTool/pathValidation.ts` and
 * `utils/permissions/pathValidation.ts`. The harness already enforces the
 * workspace boundary for `read_file` / `write_file` / `edit_file` through
 * `RuntimeHost.resolvePath`, but `bash` bypasses that entirely: `cat ../../secret`
 * is just a string until the shell runs it. This module closes that gap.
 *
 * Upstream's `PATH_EXTRACTORS` table is reproduced for the commands that matter,
 * including its `--` end-of-options handling, which exists specifically to stop
 * `rm -- -/../../etc/passwd` from evading extraction.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import type { ParsedCommand } from './command-semantics.js';
import { containsDirectoryChange, extractOutputRedirections } from './command-semantics.js';
import type { ShellFinding } from './findings.js';

export type FileOperationType = 'read' | 'create' | 'write';

/**
 * Directories where a recursive delete is never a routine operation.
 * Port of upstream `isDangerousRemovalPath`, extended with Windows roots since
 * the harness supports win32 first-class.
 */
const DANGEROUS_REMOVAL_PATHS = new Set(
  [
    '/',
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/home',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/root',
    '/sbin',
    '/srv',
    '/sys',
    '/tmp',
    '/usr',
    '/usr/bin',
    '/usr/lib',
    '/usr/local',
    '/usr/sbin',
    '/var',
    'C:\\',
    'C:\\Windows',
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\Users',
    'C:\\ProgramData',
  ].map(normalizeForComparison),
);

type PathExtractor = (args: readonly string[]) => string[];

/**
 * Extracts positional arguments, honouring the POSIX `--` end-of-options
 * delimiter. Verbatim port of upstream `filterOutFlags`, including the reason it
 * exists: after `--`, an argument starting with `-` is still a path.
 */
function filterOutFlags(args: readonly string[]): string[] {
  const result: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg);
    } else if (arg === '--') {
      afterDoubleDash = true;
    } else if (!arg.startsWith('-')) {
      result.push(arg);
    }
  }
  return result;
}

/** Port of upstream `parsePatternCommand`: grep/rg take a pattern, then paths. */
function parsePatternCommand(
  args: readonly string[],
  flagsWithArgs: ReadonlySet<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = [];
  let patternFound = false;
  let afterDoubleDash = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0];
      if (flag !== undefined && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true;
      }
      if (flag !== undefined && flagsWithArgs.has(flag) && !arg.includes('=')) index += 1;
      continue;
    }
    if (!patternFound) {
      patternFound = true;
      continue;
    }
    paths.push(arg);
  }
  return paths.length > 0 ? paths : defaults;
}

const GREP_FLAGS_WITH_ARGS = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
  '--exclude',
  '--include',
  '--exclude-dir',
  '-m',
  '--max-count',
  '-A',
  '-B',
  '-C',
  '--after-context',
  '--before-context',
  '--context',
]);

const PATH_EXTRACTORS: Record<string, PathExtractor> = {
  cd: (args) => (args.length === 0 ? [homedir()] : [args.join(' ')]),
  pushd: (args) => (args.length === 0 ? [] : [args.join(' ')]),
  ls: (args) => {
    const paths = filterOutFlags(args);
    return paths.length > 0 ? paths : ['.'];
  },
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  nl: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  md5sum: filterOutFlags,
  sha1sum: filterOutFlags,
  sha256sum: filterOutFlags,
  chmod: (args) => filterOutFlags(args).slice(1),
  chown: (args) => filterOutFlags(args).slice(1),
  ln: filterOutFlags,
  truncate: filterOutFlags,
  tee: filterOutFlags,
  grep: (args) => {
    const paths = parsePatternCommand(args, GREP_FLAGS_WITH_ARGS);
    if (paths.length === 0 && args.some((arg) => ['-r', '-R', '--recursive'].includes(arg))) {
      return ['.'];
    }
    return paths;
  },
  rg: (args) => parsePatternCommand(args, GREP_FLAGS_WITH_ARGS, ['.']),
  find: (args) => {
    const paths: string[] = [];
    let foundPredicate = false;
    let afterDoubleDash = false;
    for (const arg of args) {
      if (afterDoubleDash) {
        paths.push(arg);
        continue;
      }
      if (arg === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (arg.startsWith('-')) {
        if (['-H', '-L', '-P'].includes(arg)) continue;
        foundPredicate = true;
        continue;
      }
      if (!foundPredicate) paths.push(arg);
    }
    return paths.length > 0 ? paths : ['.'];
  },
  sed: (args) => {
    const paths: string[] = [];
    let scriptFound = false;
    let skipNext = false;
    let afterDoubleDash = false;
    for (let index = 0; index < args.length; index += 1) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      const arg = args[index];
      if (arg === undefined) continue;
      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && arg.startsWith('-')) {
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[index + 1];
          if (scriptFile !== undefined) {
            paths.push(scriptFile);
            skipNext = true;
          }
          scriptFound = true;
        } else if (['-e', '--expression'].includes(arg)) {
          skipNext = true;
          scriptFound = true;
        } else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true;
        }
        continue;
      }
      if (!scriptFound) {
        scriptFound = true;
        continue;
      }
      paths.push(arg);
    }
    return paths;
  },
};

/** Port of upstream `COMMAND_OPERATION_TYPE`. */
const COMMAND_OPERATION_TYPE: Record<string, FileOperationType> = {
  cd: 'read',
  pushd: 'read',
  ls: 'read',
  find: 'read',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  nl: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  md5sum: 'read',
  sha1sum: 'read',
  sha256sum: 'read',
  grep: 'read',
  rg: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  sed: 'write',
  chmod: 'write',
  chown: 'write',
  ln: 'write',
  truncate: 'write',
  tee: 'write',
};

/**
 * Commands where flags can redirect the target away from the positional
 * arguments (`cp --target-directory=…`), so extraction cannot be trusted.
 * Upstream blocks all flags for these; so do we.
 */
const NO_FLAGS_ALLOWED = new Set(['mv', 'cp']);

export type PathSafetyOptions = {
  /** Absolute workspace root. Paths outside it require approval. */
  workspaceRoot: string;
  /** Directory the command will run in. Defaults to `workspaceRoot`. */
  cwd?: string;
};

export function inspectCommandPaths(
  parsed: ParsedCommand,
  command: string,
  options: PathSafetyOptions,
): ShellFinding[] {
  const findings: ShellFinding[] = [];
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const cwd = path.resolve(options.cwd ?? workspaceRoot);
  const hasDirectoryChange = containsDirectoryChange(parsed);

  for (const segment of parsed.segments) {
    const base = segment.baseCommand;
    const extractor = PATH_EXTRACTORS[base];
    if (!extractor) continue;
    const operation = COMMAND_OPERATION_TYPE[base] ?? 'write';

    if (NO_FLAGS_ALLOWED.has(base) && segment.args.some((arg) => arg.startsWith('-'))) {
      findings.push({
        severity: 'ask',
        code: 'UNVERIFIABLE_TARGET',
        message: `'${base}' with flags cannot be path-validated automatically (flags such as --target-directory can move the destination)`,
      });
      continue;
    }

    // Upstream: a compound command containing `cd` invalidates path resolution
    // for any write, because paths resolve against a cwd we cannot predict.
    if (hasDirectoryChange && operation !== 'read' && parsed.segments.length > 1) {
      findings.push({
        severity: 'ask',
        code: 'CD_WITH_WRITE',
        message:
          'Command changes directory and writes in the same chain, so the effective working directory cannot be determined',
      });
      continue;
    }

    for (const candidate of extractor(segment.args)) {
      if (isGlobOrExpansion(candidate)) {
        findings.push({
          severity: 'ask',
          code: 'UNRESOLVED_PATH',
          message: `'${candidate}' contains a glob or variable and cannot be resolved before execution`,
        });
        continue;
      }
      const resolved = resolveCandidate(candidate, cwd);
      if (base === 'rm' || base === 'rmdir') {
        if (DANGEROUS_REMOVAL_PATHS.has(normalizeForComparison(resolved))) {
          findings.push({
            severity: 'block',
            code: 'DANGEROUS_REMOVAL',
            message: `'${base}' targets the critical path '${resolved}'`,
          });
          continue;
        }
      }
      if (!isWithin(workspaceRoot, resolved)) {
        findings.push({
          severity: 'ask',
          code: 'OUTSIDE_WORKSPACE',
          message: `'${base}' would ${operation} '${resolved}', which is outside the workspace ${workspaceRoot}`,
        });
      }
    }
  }

  for (const redirection of extractOutputRedirections(command)) {
    if (isGlobOrExpansion(redirection.target)) {
      findings.push({
        severity: 'ask',
        code: 'UNRESOLVED_REDIRECTION',
        message: `Output redirection target '${redirection.target}' cannot be resolved before execution`,
      });
      continue;
    }
    const resolved = resolveCandidate(redirection.target, cwd);
    if (!isWithin(workspaceRoot, resolved)) {
      findings.push({
        severity: 'ask',
        code: 'OUTSIDE_WORKSPACE',
        message: `Output is redirected to '${resolved}', which is outside the workspace ${workspaceRoot}`,
      });
    }
  }

  return findings;
}

/** Port of upstream `expandTilde`. */
export function expandTilde(candidate: string): string {
  if (candidate === '~') return homedir();
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    return path.join(homedir(), candidate.slice(2));
  }
  return candidate;
}

export function isDangerousRemovalPath(candidate: string): boolean {
  return DANGEROUS_REMOVAL_PATHS.has(normalizeForComparison(path.resolve(candidate)));
}

function resolveCandidate(candidate: string, cwd: string): string {
  const cleaned = expandTilde(candidate.replace(/^['"]|['"]$/g, ''));
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
}

function isGlobOrExpansion(candidate: string): boolean {
  return /[*?[\]{}]|\$|`/.test(candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeForComparison(candidate: string): string {
  const normalized = path.normalize(candidate).replace(/[\\/]+$/, '');
  const withRoot = normalized === '' ? path.sep : normalized;
  return process.platform === 'win32' ? withRoot.toLowerCase() : withRoot;
}

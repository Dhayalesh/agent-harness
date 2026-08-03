/**
 * Read-only command classification.
 *
 * Ported from `claude-code/src/utils/shell/readOnlyCommandValidation.ts` and
 * `BashTool/readOnlyValidation.ts`. Upstream validates flags per command against
 * a large allowlist; this port keeps the command/subcommand allowlist and the
 * flag exclusions that actually change read-only status (the ones that write
 * files or execute code), because those are the cases where a wrong answer means
 * an unprompted write.
 *
 * Being conservative is cheap here: a false negative just means the user gets
 * asked. A false positive means a silent write, so every ambiguous case
 * resolves to "not read-only".
 */

import { extractOutputRedirections, type ParsedCommand } from './command-semantics.js';

/** Commands that only read, with no flag able to make them write. */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'nl',
  'file',
  'stat',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'pwd',
  'ls',
  'tree',
  'du',
  'df',
  'diff',
  'cmp',
  'comm',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ack',
  'strings',
  'hexdump',
  'xxd',
  'od',
  'cut',
  'paste',
  'column',
  'uniq',
  'sort',
  'echo',
  'printf',
  'true',
  'false',
  'whoami',
  'id',
  'groups',
  'hostname',
  'uname',
  'uptime',
  'date',
  'which',
  'type',
  'whereis',
  'env',
  'printenv',
  'locale',
  'ps',
  'jobs',
  'top',
  'lsof',
  'netstat',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'cksum',
  'jq',
  'yq',
  'man',
  'info',
  'help',
  'node',
  'npm',
  'python',
  'python3',
]);

/** Read-only subcommands, keyed by base command. Verbatim intent from upstream. */
const READ_ONLY_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'status',
    'log',
    'diff',
    'show',
    'blame',
    'branch',
    'tag',
    'remote',
    'config',
    'describe',
    'shortlog',
    'reflog',
    'ls-files',
    'ls-tree',
    'ls-remote',
    'cat-file',
    'rev-parse',
    'rev-list',
    'name-rev',
    'symbolic-ref',
    'for-each-ref',
    'merge-base',
    'whatchanged',
    'grep',
    'count-objects',
    'verify-commit',
    'check-ignore',
    'check-attr',
  ]),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'release', 'api', 'auth', 'label', 'search']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'top', 'port', 'stats']),
  kubectl: new Set(['get', 'describe', 'logs', 'explain', 'api-resources', 'version', 'top']),
  npm: new Set([
    'ls',
    'list',
    'view',
    'info',
    'outdated',
    'audit',
    'ping',
    'why',
    'root',
    'prefix',
  ]),
  cargo: new Set(['tree', 'metadata', 'search', 'check', 'verify-project']),
  terraform: new Set(['show', 'output', 'validate', 'version', 'providers', 'graph']),
};

/**
 * Flags that turn an otherwise read-only command into a writer or executor.
 * Presence of any of these forces "not read-only".
 */
const WRITE_FLAGS: Record<string, readonly string[]> = {
  // sed -i edits in place; -f reads a script file.
  sed: ['-i', '--in-place'],
  // fd/find can execute per result.
  find: ['-exec', '-execdir', '-delete', '-fprint', '-fprintf', '-ok'],
  fd: ['-x', '--exec', '-X', '--exec-batch'],
  // GNU sort/grep can write results out.
  sort: ['-o', '--output'],
  // git config --global mutates user config; git grep is fine.
  jq: ['-f', '--from-file'],
  // date -s sets the system clock; hostname <name> sets the hostname.
  date: ['-s', '--set'],
  // tree -o and -R (which implies -o via HTML mode) write files.
  tree: ['-o', '-R'],
  // npm/node can execute arbitrary project code.
  npm: ['run', 'exec', 'install', 'i', 'ci', 'publish', 'link', 'update', 'uninstall'],
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c', '-m'],
  python3: ['-c', '-m'],
  // xargs runs an arbitrary target command.
  env: ['-i', '--ignore-environment'],
};

/**
 * Commands whose positional arguments make them writers. `hostname foo` sets the
 * hostname; `hostname` alone prints it.
 */
const READ_ONLY_ONLY_WITHOUT_ARGS = new Set(['hostname']);

export type ReadOnlyAssessment = {
  readOnly: boolean;
  /** Why the command was not classified read-only. Undefined when it was. */
  reason?: string;
};

export function assessReadOnly(command: string, parsed: ParsedCommand): ReadOnlyAssessment {
  if (parsed.unparsed) {
    return { readOnly: false, reason: 'command could not be parsed' };
  }
  if (parsed.segments.length === 0) {
    return { readOnly: false, reason: 'no command found' };
  }
  const redirections = extractOutputRedirections(command);
  if (redirections.length > 0) {
    const target = redirections[0]?.target ?? 'a file';
    return { readOnly: false, reason: `output is redirected to ${target}` };
  }

  for (const segment of parsed.segments) {
    const base = segment.baseCommand;
    if (base === '') return { readOnly: false, reason: 'empty command segment' };

    const subcommands = READ_ONLY_SUBCOMMANDS[base];
    if (subcommands) {
      const subcommand = segment.args.find((arg) => !arg.startsWith('-'));
      if (subcommand === undefined || !subcommands.has(subcommand)) {
        return { readOnly: false, reason: `'${base} ${subcommand ?? ''}'.trim() is not read-only` };
      }
      if (base === 'git' && subcommand === 'config' && !isReadOnlyGitConfig(segment.args)) {
        return { readOnly: false, reason: 'git config is being used to set a value' };
      }
      continue;
    }

    if (!READ_ONLY_COMMANDS.has(base)) {
      return { readOnly: false, reason: `'${base}' is not a known read-only command` };
    }

    const writeFlags = WRITE_FLAGS[base] ?? [];
    const offending = segment.args.find((arg) =>
      writeFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
    );
    if (offending !== undefined) {
      return { readOnly: false, reason: `'${base} ${offending}' can write or execute` };
    }
    if (base === 'sed' && segment.args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) {
      return { readOnly: false, reason: 'sed is editing in place' };
    }
    if (READ_ONLY_ONLY_WITHOUT_ARGS.has(base)) {
      const positional = segment.args.filter((arg) => !arg.startsWith('-'));
      if (positional.length > 0) {
        return { readOnly: false, reason: `'${base}' with arguments changes system state` };
      }
    }
  }
  return { readOnly: true };
}

function isReadOnlyGitConfig(args: readonly string[]): boolean {
  if (args.some((arg) => arg === '--unset' || arg === '--unset-all' || arg === '--add')) {
    return false;
  }
  if (
    args.some((arg) => arg === '--get' || arg === '--list' || arg === '-l' || arg === '--get-all')
  )
    return true;
  // `git config key value` sets; `git config key` reads.
  const positional = args.filter((arg) => !arg.startsWith('-') && arg !== 'config');
  return positional.length <= 1;
}

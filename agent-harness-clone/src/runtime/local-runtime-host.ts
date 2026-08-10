import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentAbortError, AgentHarnessError } from '../core/errors.js';
import type {
  RuntimeDirectoryEntry,
  RuntimeExecOptions,
  RuntimeExecResult,
  RuntimeFileStat,
  RuntimeHost,
} from './runtime-host.js';

export type LocalRuntimeHostOptions = {
  /**
   * The environment every spawned command receives. Defaults to `process.env`,
   * which is what a terminal user expects: their own shell already holds these
   * values, so a command run through the agent sees what the same command typed
   * by hand would see.
   *
   * A hosted deployment is the opposite case, and should pass a narrowed copy.
   * The process environment there may hold model, MCP, and AWS configuration, and a
   * shell tool is reachable by any agent record naming it, so `env` in one command
   * could put all of it in the transcript. `scrubbedEnvironment` builds that copy.
   */
  env?: NodeJS.ProcessEnv;
};

export class LocalRuntimeHost implements RuntimeHost {
  readonly kind = 'local-node';
  readonly rootDirectory: string;
  private readonly rootRealPathPromise: Promise<string>;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(rootDirectory: string, options: LocalRuntimeHostOptions = {}) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.rootRealPathPromise = realpath(this.rootDirectory);
    this.environment = options.env ?? process.env;
  }

  async resolvePath(inputPath: string, allowMissing = false): Promise<string> {
    if (inputPath.includes('\0')) {
      throw new AgentHarnessError('Path contains a null byte', 'INVALID_PATH');
    }
    const root = await this.rootRealPathPromise;
    const directCandidate = path.resolve(inputPath);
    let candidate: string;
    if (path.isAbsolute(inputPath) && this.isWithinRoot(root, directCandidate)) {
      candidate = directCandidate;
    } else {
      const lexicalCandidate = path.resolve(this.rootDirectory, inputPath);
      this.assertWithinRoot(this.rootDirectory, lexicalCandidate);
      candidate = path.resolve(root, path.relative(this.rootDirectory, lexicalCandidate));
    }
    this.assertWithinRoot(root, candidate);

    try {
      const canonical = await realpath(candidate);
      this.assertWithinRoot(root, canonical);
      return canonical;
    } catch (error) {
      if (!allowMissing || !isNotFound(error)) throw error;
      const parent = await nearestExistingParent(path.dirname(candidate));
      const canonicalParent = await realpath(parent);
      this.assertWithinRoot(root, canonicalParent);
      return candidate;
    }
  }

  async readText(inputPath: string): Promise<string> {
    const resolved = await this.resolvePath(inputPath);
    return readFile(resolved, 'utf8');
  }

  async writeText(inputPath: string, content: string): Promise<void> {
    const resolved = await this.resolvePath(inputPath, true);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  async stat(inputPath: string): Promise<RuntimeFileStat> {
    const resolved = await this.resolvePath(inputPath);
    const value = await stat(resolved);
    return {
      size: value.size,
      modifiedAtMs: value.mtimeMs,
      isFile: value.isFile(),
      isDirectory: value.isDirectory(),
    };
  }

  async readDirectory(inputPath: string): Promise<RuntimeDirectoryEntry[]> {
    const resolved = await this.resolvePath(inputPath);
    const entries = await readdir(resolved, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  }

  async execute(command: string, options: RuntimeExecOptions): Promise<RuntimeExecResult> {
    if (options.signal.aborted) throw new AgentAbortError();
    const cwd = await this.resolvePath(options.cwd ?? '.');
    const maxOutput = options.maxOutputBytes ?? 1_000_000;
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise<RuntimeExecResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        env: this.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let size = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (stream: 'stdout' | 'stderr', buffer: Buffer): void => {
        const text = buffer.toString('utf8');
        options.onOutput?.(stream, text);
        if (size >= maxOutput) {
          truncated = true;
          return;
        }
        const remaining = maxOutput - size;
        const accepted = Buffer.from(text).subarray(0, remaining).toString('utf8');
        size += Buffer.byteLength(accepted);
        if (accepted.length < text.length) truncated = true;
        if (stream === 'stdout') stdout += accepted;
        else stderr += accepted;
      };

      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

      const terminate = (): void => {
        if (child.pid === undefined) return;
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      const abort = (): void => terminate();
      options.signal.addEventListener('abort', abort, { once: true });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', abort);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', abort);
        if (options.signal.aborted) {
          reject(new AgentAbortError());
          return;
        }
        resolve({ stdout, stderr, exitCode, signal, timedOut, truncated });
      });
    });
  }

  private assertWithinRoot(root: string, candidate: string): void {
    if (!this.isWithinRoot(root, candidate)) {
      throw new AgentHarnessError(
        `Path is outside the runtime workspace: ${candidate}`,
        'WORKSPACE_BOUNDARY',
      );
    }
  }

  private isWithinRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}

async function nearestExistingParent(inputPath: string): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * The variables a spawned command keeps when the caller narrows its environment.
 *
 * These are the ones a command needs to run at all rather than ones it is being
 * told: an interpreter that cannot find its own installation fails in a way that
 * reads as a broken tool. Everything outside this list is dropped, which is the
 * point — the platform's own configuration and credentials are all outside it.
 */
export const RUNTIME_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'SHELL',
  'TERM',
  'NODE_PATH',
];

/**
 * Copies the allowlisted variables out of `source`, dropping everything else.
 *
 * Allowlist rather than denylist: a new secret added to the deployment's
 * environment is excluded by default, where a denylist would leak it until
 * somebody remembered to extend the list.
 *
 * `additional` is for variables a specific deployment's tools genuinely need,
 * such as a proxy setting. Names are copied only when `source` actually holds
 * them, so an absent variable stays absent rather than becoming an empty string
 * that a script would read as configured.
 */
export function scrubbedEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  additional: readonly string[] = [],
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const name of [...RUNTIME_ENVIRONMENT_ALLOWLIST, ...additional]) {
    const value = source[name];
    if (value !== undefined) scrubbed[name] = value;
  }
  return scrubbed;
}

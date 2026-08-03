import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHarnessError } from '../core/errors.js';

/** Matches `SkillRegistry.register`, so a name that reaches disk can be registered. */
const SKILL_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Holds a run's skill documents on local disk, and removes them when it ends.
 *
 * A skill body lives in an object store, but the runtime wants it as a file: that
 * is the shape `loadSkillsDirectory` and `parseSkill` already read
 * (`src/skills/skills.ts`), and it lets a skill be an ordinary `SKILL.md` again
 * rather than a special case. So each one is written to a private temporary
 * directory for the length of the command and deleted after it.
 *
 * Nothing here survives the process on the happy path. `dispose` is idempotent and
 * safe to call from a `finally`, which is where every caller puts it.
 */
export class TempSkillDirectory {
  private disposed = false;

  private constructor(readonly path: string) {}

  /**
   * `mkdtemp` picks the suffix, so two runs on one machine cannot collide and
   * neither can predict the other's path. On POSIX the directory is created 0700;
   * files are written 0600 regardless, since the body is an instruction set and the
   * temp directory is world-readable on some systems.
   */
  static async create(): Promise<TempSkillDirectory> {
    return new TempSkillDirectory(await mkdtemp(path.join(tmpdir(), 'agent-harness-skills-')));
  }

  /**
   * Writes one skill as `<name>/SKILL.md` and returns the path.
   *
   * The name is re-validated even though the schema already checked it: it is about
   * to become a path segment, and a stored record is the one place a `..` could
   * arrive from. The result is also confirmed to be inside the directory, so a name
   * that slipped past the pattern still cannot escape.
   */
  async write(name: string, body: string): Promise<string> {
    this.assertUsable();
    if (!SKILL_NAME.test(name)) {
      throw new AgentHarnessError(
        `Skill name '${name}' cannot be a directory name. Expected ${SKILL_NAME.source}.`,
        'SKILL_NAME_INVALID',
      );
    }
    const directory = path.join(this.path, name);
    const file = path.join(directory, 'SKILL.md');
    if (path.relative(this.path, file).startsWith('..')) {
      throw new AgentHarnessError(
        `Skill name '${name}' resolves outside the temporary directory`,
        'SKILL_NAME_INVALID',
      );
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
    return file;
  }

  /**
   * Removes the directory and everything in it. Called once per run, from the
   * `finally` that also closes the MCP connections, so a failed run leaves no
   * instruction files behind either.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // `force` so a directory already gone is not an error: dispose runs on the
    // failure path too, where the write may never have happened.
    await rm(this.path, { recursive: true, force: true });
  }

  private assertUsable(): void {
    if (!this.disposed) return;
    throw new AgentHarnessError(
      'Skill directory has been disposed: the command it belonged to has finished',
      'SKILL_DIRECTORY_DISPOSED',
    );
  }
}

import path from 'node:path';
import type { RuntimeHost } from '../runtime/runtime-host.js';

export type ProjectContext = Record<string, string>;

export interface ProjectContextProvider {
  collect(signal: AbortSignal): Promise<ProjectContext>;
}

export class LocalProjectContextProvider implements ProjectContextProvider {
  constructor(private readonly runtime: RuntimeHost) {}

  async collect(signal: AbortSignal): Promise<ProjectContext> {
    const context: ProjectContext = {
      workingDirectory: this.runtime.rootDirectory,
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    };
    try {
      const git = await this.runtime.execute('git status --short --branch', {
        signal,
        timeoutMs: 5_000,
        maxOutputBytes: 20_000,
      });
      if (git.exitCode === 0) context.gitStatus = git.stdout.trim();
    } catch {
      // A non-git workspace remains valid.
    }
    try {
      const packagePath = path.join(this.runtime.rootDirectory, 'package.json');
      const packageJson: unknown = JSON.parse(await this.runtime.readText(packagePath));
      if (packageJson && typeof packageJson === 'object') {
        const record = packageJson as Record<string, unknown>;
        if (typeof record.name === 'string') context.packageName = record.name;
        if (typeof record.packageManager === 'string')
          context.packageManager = record.packageManager;
      }
    } catch {
      // package.json is optional.
    }
    return context;
  }
}

export function formatProjectContext(context: ProjectContext): string {
  return `<project-context>\n${Object.entries(context)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n</project-context>`;
}

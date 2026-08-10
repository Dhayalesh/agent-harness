import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { emitLog, type LogContext, type LogSink } from '../services/observability.js';
import type { Tool } from '../tools/tool.js';

export type Skill = {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  source?: string;
};

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  constructor(initialSkills: readonly Skill[] = []) {
    for (const skill of initialSkills) this.register(skill);
  }

  register(skill: Skill): () => void {
    if (!/^[A-Za-z0-9_-]+$/.test(skill.name)) throw new Error(`Invalid skill name: ${skill.name}`);
    if (this.skills.has(skill.name)) throw new Error(`Skill already registered: ${skill.name}`);
    this.skills.set(skill.name, structuredClone(skill));
    return () => this.skills.delete(skill.name);
  }

  get(name: string): Skill | undefined {
    const skill = this.skills.get(name);
    return skill ? structuredClone(skill) : undefined;
  }

  list(): Skill[] {
    return [...this.skills.values()].map((skill) => structuredClone(skill));
  }
}

export async function loadSkillsDirectory(directory: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = entry.isDirectory()
      ? path.join(directory, entry.name, 'SKILL.md')
      : entry.isFile() && entry.name.endsWith('.md')
        ? path.join(directory, entry.name)
        : undefined;
    if (!candidate) continue;
    try {
      skills.push(parseSkill(await readFile(candidate, 'utf8'), candidate));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return skills;
}

export function parseSkill(content: string, source?: string): Skill {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const metadata: Record<string, string> = {};
  let instructions = content.trim();
  if (match) {
    for (const line of match[1]?.split(/\r?\n/) ?? []) {
      const separator = line.indexOf(':');
      if (separator > 0)
        metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    instructions = match[2]?.trim() ?? '';
  }
  const inferredName = source ? path.basename(path.dirname(source)) : undefined;
  const name = metadata.name || inferredName;
  if (!name) throw new Error('Skill requires a name');
  return {
    name,
    description: metadata.description || `Instructions for ${name}`,
    instructions,
    ...(metadata.allowedTools
      ? {
          allowedTools: metadata.allowedTools
            .split(',')
            .map((tool) => tool.trim())
            .filter(Boolean),
        }
      : {}),
    ...(source === undefined ? {} : { source }),
  };
}

const skillInput = z.object({ name: z.string().min(1) });

export function createSkillTool(
  registry: SkillRegistry,
  options: { logSink?: LogSink; logContext?: LogContext } = {},
): Tool<z.infer<typeof skillInput>> {
  return {
    name: 'skill',
    description: `Load a reusable workflow. Available skills: ${registry
      .list()
      .map((skill) => `${skill.name} (${skill.description})`)
      .join(', ')}`,
    inputSchema: skillInput,
    jsonSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    kind: 'read',
    concurrencySafe: true,
    async execute({ name }, context) {
      const started = Date.now();
      const correlation = {
        ...(options.logContext ?? {}),
        sessionId: context.sessionId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        skillName: name,
      };
      emitLog(options.logSink, {
        ...correlation,
        event: 'skill.load.started',
      });
      try {
        const skill = registry.get(name);
        if (!skill) throw new Error(`Unknown skill: ${name}`);
        const content = [
          `<skill name="${skill.name}">`,
          skill.instructions,
          skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : '',
          '</skill>',
        ]
          .filter(Boolean)
          .join('\n');
        const metadata = { skill: skill.name, source: skill.source };
        emitLog(options.logSink, {
          ...correlation,
          event: 'skill.load.completed',
          durationMs: Date.now() - started,
          instructionChars: skill.instructions.length,
          contentChars: content.length,
          allowedToolCount: skill.allowedTools?.length ?? 0,
          sourceKind: skill.source === undefined ? 'inline' : 'file',
        });
        return { content, metadata };
      } catch (error) {
        emitLog(options.logSink, {
          ...correlation,
          level: 'error',
          event: 'skill.load.failed',
          durationMs: Date.now() - started,
          error: describeError(error),
        });
        throw error;
      }
    },
  };
}

function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(code === undefined ? {} : { code }),
  };
}

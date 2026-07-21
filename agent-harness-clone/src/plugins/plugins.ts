import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { HookRegistry } from '../hooks/hooks.js';
import { ModelProviderRegistry } from '../models/registry.js';
import type { SkillRegistry } from '../skills/skills.js';
import type { ToolRegistry } from '../tools/registry.js';

const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  main: z.string().min(1),
  capabilities: z.array(z.enum(['tools', 'skills', 'hooks', 'providers', 'network'])).default([]),
});

export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginCapability = PluginManifest['capabilities'][number];

export type PluginContext = {
  tools: ToolRegistry;
  skills: SkillRegistry;
  hooks: HookRegistry;
  providers: ModelProviderRegistry;
  capabilities: ReadonlySet<PluginCapability>;
};

export type PluginLoaderContext = Omit<PluginContext, 'capabilities' | 'providers'> & {
  providers?: ModelProviderRegistry;
};

export type AgentHarnessPlugin = {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  directory: string;
  deactivate(): Promise<void>;
};

export type PluginLoaderOptions = {
  trustedRoots: readonly string[];
  grantedCapabilities?: readonly PluginCapability[];
};

export class PluginLoader {
  private readonly granted: ReadonlySet<PluginCapability>;
  private readonly providers: ModelProviderRegistry;

  constructor(
    private readonly context: PluginLoaderContext,
    private readonly options: PluginLoaderOptions,
  ) {
    this.granted = new Set(options.grantedCapabilities ?? ['tools', 'skills', 'hooks']);
    this.providers = context.providers ?? new ModelProviderRegistry();
  }

  async load(directory: string): Promise<LoadedPlugin> {
    const pluginDirectory = await realpath(directory);
    const trustedRoots = await Promise.all(this.options.trustedRoots.map((root) => realpath(root)));
    if (!trustedRoots.some((root) => within(root, pluginDirectory))) {
      throw new Error(`Plugin is outside trusted roots: ${pluginDirectory}`);
    }
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(pluginDirectory, 'agent-harness.plugin.json'), 'utf8')),
    );
    for (const capability of manifest.capabilities) {
      if (!this.granted.has(capability)) {
        throw new Error(`Plugin ${manifest.name} requires ungranted capability: ${capability}`);
      }
    }
    const mainPath = await realpath(path.resolve(pluginDirectory, manifest.main));
    if (!within(pluginDirectory, mainPath)) throw new Error('Plugin main is outside its directory');
    const module: unknown = await import(`${pathToFileURL(mainPath).href}?v=${Date.now()}`);
    const plugin = resolvePlugin(module);
    const capabilities = new Set(manifest.capabilities);
    const cleanups: Array<() => void> = [];
    try {
      await plugin.activate({
        tools: capabilityProxy(this.context.tools, capabilities.has('tools'), 'tools', cleanups),
        skills: capabilityProxy(
          this.context.skills,
          capabilities.has('skills'),
          'skills',
          cleanups,
        ),
        hooks: capabilityProxy(this.context.hooks, capabilities.has('hooks'), 'hooks', cleanups),
        providers: capabilityProxy(
          this.providers,
          capabilities.has('providers'),
          'providers',
          cleanups,
        ),
        capabilities,
      });
    } catch (error) {
      cleanupContributions(cleanups);
      throw error;
    }
    let active = true;
    return {
      manifest,
      directory: pluginDirectory,
      deactivate: async () => {
        if (!active) return;
        active = false;
        try {
          await plugin.deactivate?.();
        } finally {
          cleanupContributions(cleanups);
        }
      },
    };
  }
}

function capabilityProxy<T extends object>(
  target: T,
  allowed: boolean,
  capability: PluginCapability,
  cleanups: Array<() => void>,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'register') {
        if (!allowed) {
          return () => {
            throw new Error(`Plugin did not declare capability: ${capability}`);
          };
        }
        return (contribution: { name?: string }, ...args: unknown[]) => {
          const register = Reflect.get(object, property, receiver) as (
            ...values: unknown[]
          ) => unknown;
          const result = Reflect.apply(register, object, [contribution, ...args]);
          if (typeof result === 'function') cleanups.push(result as () => void);
          else if (contribution.name && 'unregister' in object) {
            const registry = object as { unregister(name: string): unknown };
            cleanups.push(() => void registry.unregister(contribution.name as string));
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

function cleanupContributions(cleanups: Array<() => void>): void {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

function resolvePlugin(module: unknown): AgentHarnessPlugin {
  if (!module || typeof module !== 'object') throw new Error('Plugin module is invalid');
  const record = module as Record<string, unknown>;
  const candidate = (record.default ?? record.plugin) as Partial<AgentHarnessPlugin> | undefined;
  if (!candidate || typeof candidate.activate !== 'function') {
    throw new Error('Plugin must export an activate function');
  }
  return candidate as AgentHarnessPlugin;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

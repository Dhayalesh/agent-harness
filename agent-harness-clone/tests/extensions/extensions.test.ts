import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CommandRegistry,
  HookRegistry,
  mergeConfigLayers,
  ModelProviderRegistry,
  parseSkill,
  PluginLoader,
  SkillRegistry,
  ToolRegistry,
} from '../../src/index.js';

test('configuration layers merge nested values and validate them', () => {
  const config = mergeConfigLayers([
    { name: 'defaults', value: { limits: { maxTurns: 10, maxOutputTokens: 100 } } },
    { name: 'project', value: { limits: { maxTurns: 20 }, model: 'test-model' } },
  ]);
  assert.deepEqual(config.limits, { maxTurns: 20, maxOutputTokens: 100 });
  assert.equal(config.model, 'test-model');
  assert.throws(
    () => mergeConfigLayers([{ name: 'bad', value: { limits: { maxTurns: 0 } } }]),
    /(?:greater than|>)\s*0/,
  );
});

test('plugin cannot register a capability it did not declare', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-plugin-denied-'));
  const directory = path.join(root, 'denied');
  await mkdir(directory);
  await writeFile(
    path.join(directory, 'agent-harness.plugin.json'),
    JSON.stringify({
      name: 'denied',
      version: '1.0.0',
      main: 'index.mjs',
      capabilities: ['skills'],
    }),
  );
  await writeFile(
    path.join(directory, 'index.mjs'),
    `export default { activate(context) { context.tools.register({name: 'bad'}); } };`,
  );
  try {
    const loader = new PluginLoader(
      {
        tools: new ToolRegistry(),
        skills: new SkillRegistry(),
        hooks: new HookRegistry(),
      },
      { trustedRoots: [root], grantedCapabilities: ['skills', 'tools'] },
    );
    await assert.rejects(loader.load(directory), /did not declare capability: tools/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skills and prompt commands are parsed independently of a UI', async () => {
  const skill = parseSkill(
    '---\nname: verify\ndescription: Verify work\nallowedTools: read_file,bash\n---\nRun focused tests.',
  );
  assert.equal(skill.name, 'verify');
  assert.deepEqual(skill.allowedTools, ['read_file', 'bash']);

  const commands = new CommandRegistry();
  commands.register({
    type: 'prompt',
    name: 'review',
    description: 'Review code',
    expand: (args) => `Review ${args}`,
  });
  assert.deepEqual(await commands.resolve('/review src'), {
    type: 'prompt',
    prompt: 'Review src',
  });
});

test('trusted plugin contributions are removed automatically on deactivation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-plugin-'));
  const directory = path.join(root, 'sample');
  await mkdir(directory);
  await writeFile(
    path.join(directory, 'agent-harness.plugin.json'),
    JSON.stringify({
      name: 'sample',
      version: '1.0.0',
      main: 'index.mjs',
      capabilities: ['skills', 'tools', 'providers'],
    }),
  );
  await writeFile(
    path.join(directory, 'index.mjs'),
    `export default {
  activate(context) {
    context.skills.register({name: 'plugin-skill', description: 'sample', instructions: 'work'});
    context.tools.register({
      name: 'plugin-tool',
      description: 'sample tool',
      inputSchema: { safeParse(input) { return { success: true, data: input }; } },
      jsonSchema: { type: 'object' },
      kind: 'read',
      concurrencySafe: true,
      async execute() { return { content: 'plugin output' }; }
    });
    context.providers.register({
      name: 'plugin-provider',
      async *stream() { yield {type: 'completed', stopReason: 'end_turn'}; }
    });
  }
};`,
  );
  try {
    const skills = new SkillRegistry();
    const loaderContextTools = new ToolRegistry();
    const providers = new ModelProviderRegistry();
    const loader = new PluginLoader(
      { tools: loaderContextTools, skills, hooks: new HookRegistry(), providers },
      { trustedRoots: [root], grantedCapabilities: ['skills', 'tools', 'providers'] },
    );
    const plugin = await loader.load(directory);
    assert.equal(skills.get('plugin-skill')?.description, 'sample');
    assert.equal(loaderContextTools.get('plugin-tool')?.description, 'sample tool');
    assert.equal(providers.get('plugin-provider')?.name, 'plugin-provider');
    await plugin.deactivate();
    assert.equal(skills.get('plugin-skill'), undefined);
    assert.equal(loaderContextTools.get('plugin-tool'), undefined);
    assert.equal(providers.get('plugin-provider'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

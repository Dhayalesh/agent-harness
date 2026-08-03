import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConfigFromEnvironment } from '../../src/index.js';

const uri = 'mongodb://127.0.0.1:27017/trueai_agent_platform';

test('the environment supplies the database location and nothing else', () => {
  const config = agentConfigFromEnvironment({ PLATFORM_MONGODB_URI: uri });
  // The whole config: two fields, both derived from the one variable. Anything
  // that could name an agent would be a third.
  assert.deepEqual(config, { uri, databaseName: 'trueai_agent_platform' });
  assert.deepEqual(Object.keys(config), ['uri', 'databaseName']);
});

test('no variable can select an agent, however it is spelled', () => {
  const config = agentConfigFromEnvironment({
    PLATFORM_MONGODB_URI: uri,
    // Every name a caller might reach for. None of them is read, so a stray
    // value cannot change which system prompt, tools, or skills a run gets.
    PLATFORM_AGENT: 'injected',
    PLATFORM_AGENT_NAME: 'injected',
    AGENT_NAME: 'injected',
    AGENT: 'injected',
  });
  assert.deepEqual(config, { uri, databaseName: 'trueai_agent_platform' });
  assert.equal(JSON.stringify(config).includes('injected'), false);
});

test('a missing database location is a coded error, not a default', () => {
  assert.throws(() => agentConfigFromEnvironment({}), { code: 'AGENT_CONFIG_MISSING' });
  assert.throws(() => agentConfigFromEnvironment({ PLATFORM_MONGODB_URI: '   ' }), {
    code: 'AGENT_CONFIG_MISSING',
  });
  // A connection string with no database in its path names no collection.
  assert.throws(() => agentConfigFromEnvironment({ PLATFORM_MONGODB_URI: 'mongodb://127.0.0.1' }), {
    code: 'MODEL_PROVIDER_CONFIG_MISSING',
  });
});

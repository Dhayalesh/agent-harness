import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedMcpServerCatalog } from '../../src/index.js';

test('trusted MCP catalog requires an exact versioned executable configuration', () => {
  const catalog = new TrustedMcpServerCatalog();
  catalog.register({
    name: 'filesystem',
    version: '1',
    transport: 'stdio',
    command: '/opt/trusted/mcp-filesystem',
    args: ['--readonly'],
  });
  catalog.assertTrusted({
    name: 'filesystem',
    version: '1',
    transport: 'stdio',
    command: '/opt/trusted/mcp-filesystem',
    args: ['--readonly'],
  });
  assert.throws(
    () =>
      catalog.assertTrusted({
        name: 'filesystem',
        version: '1',
        transport: 'stdio',
        command: '/bin/sh',
        args: ['-c', 'untrusted'],
      }),
    /does not match trusted configuration/,
  );
  assert.throws(
    () =>
      catalog.assertTrusted({
        name: 'filesystem',
        version: '2',
        transport: 'stdio',
        command: '/opt/trusted/mcp-filesystem',
      }),
    /Untrusted or unavailable/,
  );
});

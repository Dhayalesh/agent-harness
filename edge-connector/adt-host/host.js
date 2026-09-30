#!/usr/bin/env node
/**
 * sap-adt-host - Standalone SAP ADT MCP Host
 *
 * Connects to SAP NetWeaver / S/4HANA systems and exposes the full SAP ADT
 * tool suite over stdio JSON-RPC 2.0.
 *
 * Implemented using @mcp-abap-adt/lib (Apache-2.0) and @modelcontextprotocol/sdk (MIT).
 * STRICTLY NO AGPL-3.0 dependencies (@mcp-abap-adt/core is NEVER imported).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const candidatePaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(process.env.APPDATA || '', 'npm/node_modules/@mcp-abap-adt/core/node_modules'),
  path.resolve(process.env.APPDATA || '', 'npm/node_modules'),
];

// Configure candidate module paths for unbundled development execution
if (typeof module !== 'undefined' && module.paths) {
  for (const cp of candidatePaths) {
    if (fs.existsSync(cp) && !module.paths.includes(cp)) {
      module.paths.unshift(cp);
    }
  }
}

// Redirect all standard log calls to stderr to keep stdout 100% clean for JSON-RPC 2.0
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

function log(msg) {
  process.stderr.write(`[sap-adt-host] ${msg}\n`);
}

function parseArgs(args) {
  const parsed = {
    envPath: '',
    systemType: 'onprem',
    transport: 'stdio',
    destination: 'default',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--env-path=')) {
      parsed.envPath = arg.substring('--env-path='.length);
    } else if (arg === '--env-path' && i + 1 < args.length) {
      parsed.envPath = args[++i];
    } else if (arg.startsWith('--env=')) {
      parsed.envPath = arg.substring('--env='.length);
    } else if (arg === '--env' && i + 1 < args.length) {
      parsed.envPath = args[++i];
    } else if (arg.startsWith('--system-type=')) {
      parsed.systemType = arg.substring('--system-type='.length);
    } else if (arg === '--system-type' && i + 1 < args.length) {
      parsed.systemType = args[++i];
    } else if (arg.startsWith('--transport=')) {
      parsed.transport = arg.substring('--transport='.length);
    } else if (arg === '--transport' && i + 1 < args.length) {
      parsed.transport = args[++i];
    } else if (arg.startsWith('--mcp=')) {
      parsed.destination = arg.substring('--mcp='.length);
    } else if (arg === '--mcp' && i + 1 < args.length) {
      parsed.destination = args[++i];
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log('Starting Standalone SAP ADT MCP Host v1.0.0');
  log(`System type: ${args.systemType}, Transport: ${args.transport}`);

  let resolvedEnvPath = '';
  if (args.envPath) {
    const cand = path.resolve(args.envPath);
    if (fs.existsSync(cand)) {
      resolvedEnvPath = cand;
    } else {
      log(`WARNING: Configured env file not found: ${cand}`);
    }
  }

  if (!resolvedEnvPath) {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      const defaultEnv = path.join(localAppData, 'TrueAI', 'Edge', 'sap.env');
      if (fs.existsSync(defaultEnv)) {
        resolvedEnvPath = defaultEnv;
      }
    }
  }

  // Dynamic imports of permissive libraries
  const { EmbeddableMcpServer } = require('@mcp-abap-adt/lib/embeddable');
  const { AuthBrokerFactory } = require('@mcp-abap-adt/lib/auth');
  const { createAbapConnection } = require('@mcp-abap-adt/connection');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

  let connection;
  const isConfigured = Boolean(resolvedEnvPath);

  if (isConfigured) {
    log(`Resolved env path: ${resolvedEnvPath}`);
    const brokerFactory = new AuthBrokerFactory({
      envFilePath: resolvedEnvPath,
      transportType: 'stdio',
      unsafe: false,
      defaultDestination: args.destination,
    });

    await brokerFactory.initializeDefaultBroker();
    const broker = brokerFactory.getDefaultBroker();
    if (!broker) {
      log('ERROR: Failed to initialize AuthBroker from configured env file');
      process.exit(1);
    }

    const connectionConfig = await broker.getConnectionConfig(args.destination);
    if (!connectionConfig) {
      log(`ERROR: No connection configuration found for destination: ${args.destination}`);
      process.exit(1);
    }

    const authType = connectionConfig.authType ||
      (connectionConfig.username && connectionConfig.password ? 'basic' : 'jwt');

    const connectionParams = authType === 'basic'
      ? {
          url: connectionConfig.serviceUrl || '',
          authType: 'basic',
          username: connectionConfig.username || '',
          password: connectionConfig.password || '',
          client: connectionConfig.sapClient || '',
        }
      : {
          url: connectionConfig.serviceUrl || '',
          authType: 'jwt',
          jwtToken: connectionConfig.authorizationToken || '',
          client: connectionConfig.sapClient || '',
        };

    let tokenRefresher;
    if (authType === 'jwt' && typeof broker.createTokenRefresher === 'function') {
      tokenRefresher = broker.createTokenRefresher(args.destination);
    }

    log(`Initializing SAP connection context (Auth type: ${authType}, Service URL: ${connectionParams.url})`);
    connection = createAbapConnection(connectionParams, null, args.destination, tokenRefresher);
  } else {
    log('Running in unconfigured customer mode (no env file supplied)');
    log('All 206 SAP ADT tools are exposed for discovery and schema inspection. Live calls require SAP configuration.');
    const placeholderParams = {
      url: 'http://127.0.0.1:0',
      authType: 'basic',
      username: 'unconfigured',
      password: 'unconfigured',
      client: '000',
    };
    connection = createAbapConnection(placeholderParams, null, args.destination, null);
  }

  // Create EmbeddableMcpServer with the full tool suite matching production
  // exposition ['readonly', 'high', 'system', 'search'] produces exactly 206 tools
  const server = new EmbeddableMcpServer({
    connection,
    systemType: args.systemType,
    exposition: ['readonly', 'high', 'system', 'search'],
  });

  const toolCount = Object.keys(server._registeredTools || {}).length;
  log(`EmbeddableMcpServer initialized with ${toolCount} registered tools`);

  // Connect stdio transport immediately so MCP initialize & tools/list respond instantaneously
  // NEVER block stdio connection on synchronous SAP network calls
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP stdio transport connected and listening for JSON-RPC requests');

  if (isConfigured) {
    // Verify / establish session in background without blocking MCP protocol startup
    connection.connect().then(() => {
      log('SAP session established successfully');
    }).catch((err) => {
      log(`WARNING: Initial SAP background connection status: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Handle process shutdown cleanly
  process.on('SIGINT', async () => {
    log('Received SIGINT, shutting down');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('Received SIGTERM, shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[sap-adt-host] FATAL: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

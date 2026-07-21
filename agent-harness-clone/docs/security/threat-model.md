# Threat model

## Protected assets

- source code and files outside the selected workspace;
- shell/process capabilities;
- API credentials and plugin secrets;
- session control tokens and persisted transcripts;
- remote runtime and MCP connections.

## Trust boundaries

- model output is untrusted and schema validated;
- browser, web, desktop renderer, and IDE messages are untrusted transports;
- local/remote `RuntimeHost` implementations are the capability boundary;
- plugins are loaded only from configured trusted roots and receive explicit
  capabilities;
- MCP servers are external principals and their tool results are untrusted.

## Required controls

- canonical workspace and symlink checks before filesystem access;
- fail-closed permissions for mutations and execution;
- process timeouts, output limits, cancellation, and concurrency quotas;
- secret providers that never serialize credentials into events;
- authenticated session gateways with separate unguessable control tokens;
- bounded request bodies, event logs, transcripts, artifacts, and tool output;
- schema validation for provider tool calls, config, plugins, and commands;
- deterministic traversal, permission-bypass, cancellation, and replay tests.

Browser code never receives direct filesystem or process capabilities. It uses
an authenticated gateway connected to a separately authorized runtime host.

# Distribution and update strategy

The core is published as a versioned npm library. Surface packages pin a
compatible core range and update independently:

- CLI: npm package with the `agent-harness` executable;
- server: container or Node service using the same npm library;
- desktop: signed application bundle containing a pinned core build;
- IDE: marketplace extension containing or connecting to a compatible bridge;
- SDK: npm exports with semantic versioning.

Event and RPC protocols carry explicit compatibility versions before a remote
surface is released. Update discovery is an optional service; the core continues
to run when it is disabled or unavailable.

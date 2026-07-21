# Clean-room implementation rules

The reference tree is used to identify externally observable concepts and
behavior. The clone uses independent module boundaries, names, types, tests, and
implementations.

- Do not copy reference source files or large verbatim code fragments.
- Record desired behavior as a contract or test before implementing it.
- Prefer public protocol/API documentation for provider and MCP integrations.
- Keep reference-specific internal services out of the clone unless they map to
  an explicit product requirement.
- Preserve provenance and licenses for third-party dependencies.
- Review new migrations for accidental UI, analytics, authentication, or global
  state coupling in the harness core.

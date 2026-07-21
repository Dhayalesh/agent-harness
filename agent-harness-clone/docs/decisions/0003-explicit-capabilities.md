# ADR 0003: Explicit runtime capabilities

- Status: accepted

Filesystem, process, network, secret, and persistence access are injected as
capabilities. Browser and remote consumers never receive local process access
implicitly. Missing or unapproved capabilities fail closed.

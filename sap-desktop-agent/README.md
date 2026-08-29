# SAP Desktop Agent

See [`docs/sap-desktop-agent-plan.md`](../docs/sap-desktop-agent-plan.md) §4 for
the design and the phased build. `phase0/read_table.py` is Phase 0: a
standalone script, not yet run against any real SAP system, that answers the
one question the rest of the plan depends on — does SAP GUI Scripting give
clean access to a table screen on this SAP version. Run it by hand on a
Windows machine with SAP GUI, per the requirements at the top of that file,
before building anything further here.

Nothing past Phase 0 exists yet.

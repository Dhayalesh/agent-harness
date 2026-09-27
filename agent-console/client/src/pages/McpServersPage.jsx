import { useCallback, useMemo } from "react";
import { api } from "../api.js";
import { MonoValue, StatusPill, Tag } from "../components/Bits.jsx";
import { CellStack } from "../components/DataTable.jsx";
import { ResourceListPage, updatedColumn } from "./ResourceListPage.jsx";

const CAPABILITY_NAMES = ["tools", "resources", "prompts", "elicitation"];

const capabilityNames = (capabilities = {}) =>
  CAPABILITY_NAMES.filter((name) => capabilities[name]);

/** stdio servers use their command line; HTTP and Edge servers use their URL. */
const endpointOf = (row) =>
  row.transport === "stdio"
    ? [row.command, ...(row.args ?? [])].filter(Boolean).join(" ")
    : row.url;

export function McpServersPage() {
  const load = useCallback(
    async (q) => (await api.listMcpServers({ q })).mcpServers,
    [],
  );
  const remove = useCallback((row) => api.deleteMcpServer(row.id), []);
  const search = useCallback(
    (row) => [row.name, row.transport, row.command, row.url],
    [],
  );

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Server",
        primary: true,
        sortable: true,
        width: "24%",
        value: (row) => row.name,
        render: (row) => (
          <CellStack
            title={row.name}
            subtitle={`${row.auth?.kind ?? "no"} auth${
              row.hasApiKey ? "· credential set" : ""
            }`}
          />
        ),
      },
      {
        key: "transport",
        header: "Transport",
        sortable: true,
        width: "112px",
        value: (row) => row.transport,
        render: (row) => <Tag tone="brand">{row.transport}</Tag>,
      },
      {
        key: "endpoint",
        header: "Endpoint",
        width: "28%",
        hideBelow: "lg",
        value: endpointOf,
        render: (row) => (
          <MonoValue className="line-clamp-1">
            {endpointOf(row) || "—"}
          </MonoValue>
        ),
      },
      {
        key: "capabilities",
        header: "Capabilities",
        width: "168px",
        hideBelow: "xl",
        value: (row) => capabilityNames(row.capabilities).join(","),
        render: (row) => {
          const names = capabilityNames(row.capabilities);
          if (names.length === 0)
            return <span className="text-default-400">none</span>;
          return (
            <span className="flex flex-wrap gap-1">
              {names.map((name) => (
                <Tag key={name}>{name}</Tag>
              ))}
            </span>
          );
        },
      },
      {
        key: "timeouts",
        header: "Timeouts",
        numeric: true,
        width: "128px",
        hideBelow: "xl",
        value: (row) => row.capabilities?.requestTimeoutMs,
        render: (row) =>
          `${row.capabilities?.connectTimeoutMs ?? "—"} / ${
            row.capabilities?.requestTimeoutMs ?? "—"
          }ms`,
      },
      {
        key: "state",
        header: "State",
        width: "156px",
        value: (row) => (row.enabled ? "enabled" : "disabled"),
        render: (row) => (
          <span className="flex flex-wrap items-center gap-1">
            <StatusPill status={row.enabled ? "enabled" : "disabled"} />
            {row.autoConnect && <StatusPill status="auto" />}
          </span>
        ),
      },
      updatedColumn(),
    ],
    [],
  );

  return (
    <ResourceListPage
      breadcrumbs={[{ label: "Configuration" }, { label: "MCP servers" }]}
      title="MCP servers"
      description="Tool, resource, and prompt servers the runtime can connect to for an agent run."
      newHref="/mcp-servers/new"
      newLabel="New MCP server"
      singular="MCP server"
      plural="servers"
      emptyIcon="plug"
      emptyDescription="Add a stdio process, HTTP endpoint, or Edge server the runtime can connect to."
      searchPlaceholder="Search name, transport or endpoint"
      editHref={(row) => `/mcp-servers/${row.id}/edit`}
      columns={columns}
      load={load}
      remove={remove}
      search={search}
    />
  );
}

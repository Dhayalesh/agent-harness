import { Button, Chip, Code } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import {
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  SearchInput,
  StatusPill,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";
import { ResourceRow } from "../components/ResourceRow.jsx";

const capabilityNames = (capabilities = {}) =>
  ["tools", "resources", "prompts", "elicitation"]
    .filter((name) => capabilities[name])
    .join(", ");

export function McpServersPage() {
  const [mcpServers, setMcpServers] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const { mcpServers: found } = await api.listMcpServers({ q });
      setMcpServers(found);
    } catch (caught) {
      setError(caught);
      setMcpServers([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const visibleMcpServers = useMemo(() => {
    if (!mcpServers || !query.trim()) return mcpServers;
    const needle = query.trim().toLowerCase();
    return mcpServers.filter((mcpServer) =>
      [mcpServer.name, mcpServer.transport, mcpServer.command, mcpServer.url]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [mcpServers, query]);

  const remove = async (mcpServer) => {
    const confirmed = await confirm({
      title: "Delete MCP server",
      body: `Delete MCP server "${mcpServer.name}"? Agents that reference it must be updated first.`,
      confirmLabel: "Delete server",
    });
    if (!confirmed) return;

    try {
      await api.deleteMcpServer(mcpServer.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Build"
        title="MCP servers"
        description="Tool, resource, and prompt servers the runtime can connect to for an agent run."
        actions={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              label="Search MCP servers"
              placeholder="Search MCP servers"
            />
            <Button
              color="primary"
              radius="md"
              href="/mcp-servers/new"
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New MCP server
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {mcpServers === null ? (
        <Loading what="MCP servers" />
      ) : visibleMcpServers.length === 0 ? (
        <EmptyState
          icon="plug"
          title={
            query ? "No MCP servers match this search." : "No MCP servers found."
          }
          description={
            query
              ? "Try a different search."
              : "Add a stdio process or HTTP endpoint the runtime can connect to."
          }
          action={
            !query && (
              <Button color="primary" radius="md" href="/mcp-servers/new">
                Create one
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visibleMcpServers.map((mcpServer) => (
            <li key={mcpServer.id}>
              <ResourceRow
                title={mcpServer.name}
                editHref={`/mcp-servers/${mcpServer.id}/edit`}
                deleteLabel={`Delete ${mcpServer.name}`}
                onDelete={() => remove(mcpServer)}
                badges={
                  <>
                    <Chip
                      size="sm"
                      variant="flat"
                      color="primary"
                      classNames={{
                        base: "h-5 rounded-full",
                        content:
                          "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
                      }}
                    >
                      {mcpServer.transport}
                    </Chip>
                    <StatusPill
                      status={mcpServer.enabled ? "enabled" : "disabled"}
                    />
                    {mcpServer.autoConnect && <StatusPill status="auto" />}
                  </>
                }
                summary={
                  mcpServer.transport === "stdio" ? (
                    <Code size="sm" className="text-tiny">
                      {[mcpServer.command, ...(mcpServer.args ?? [])]
                        .filter(Boolean)
                        .join(" ")}
                    </Code>
                  ) : (
                    mcpServer.url
                  )
                }
                meta={[
                  {
                    label: "Capabilities",
                    value: capabilityNames(mcpServer.capabilities) || "none",
                  },
                  {
                    label: "Authentication",
                    value: `${mcpServer.auth?.kind ?? "none"}${
                      mcpServer.hasApiKey ? ", credential configured" : ""
                    }`,
                  },
                  {
                    label: "Timeouts",
                    value: `${
                      mcpServer.capabilities?.connectTimeoutMs ?? "-"
                    }ms / ${mcpServer.capabilities?.requestTimeoutMs ?? "-"}ms`,
                  },
                  { label: "Updated", value: when(mcpServer.updatedAt) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmDialog}
    </section>
  );
}

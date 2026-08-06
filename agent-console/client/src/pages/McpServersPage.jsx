import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  when,
} from "../components/Bits.jsx";

const capabilityNames = (capabilities = {}) =>
  ["tools", "resources", "prompts", "elicitation"]
    .filter((name) => capabilities[name])
    .join(", ");

export function McpServersPage() {
  const [mcpServers, setMcpServers] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

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
    const confirmed = window.confirm(
      `Delete MCP server "${mcpServer.name}"? Agents that reference it must be updated first.`,
    );
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
      <div className="page-head">
        <div>
          <h1>MCP servers</h1>
          <p className="muted">
            Tool, resource, and prompt servers the runtime can connect to for an
            agent run.
          </p>
        </div>
        <div className="resource-toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search MCP servers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search MCP servers"
          />
          <Link to="/mcp-servers/new">New MCP server</Link>
        </div>
      </div>

      <ErrorNote error={error} />

      {mcpServers === null ? (
        <Loading what="MCP servers" />
      ) : visibleMcpServers.length === 0 ? (
        <p className="empty">
          {query ? "No MCP servers match this search." : "No MCP servers found."}{" "}
          {!query && <Link to="/mcp-servers/new">Create one</Link>}
          {!query && "."}
        </p>
      ) : (
        <ul className="resource-list">
          {visibleMcpServers.map((mcpServer) => (
            <li key={mcpServer.id} className="resource-row">
              <div className="resource-summary">
                <div className="resource-title-row">
                  <strong>{mcpServer.name}</strong>
                  <span className="resource-badges">
                    <span className={`pill pill-${mcpServer.transport}`}>
                      {mcpServer.transport}
                    </span>
                    <StatusPill
                      status={mcpServer.enabled ? "enabled" : "disabled"}
                    />
                    {mcpServer.autoConnect && <StatusPill status="auto" />}
                  </span>
                </div>
                <p className="muted">
                  {mcpServer.transport === "stdio" ? (
                    <code>
                      {[mcpServer.command, ...(mcpServer.args ?? [])]
                        .filter(Boolean)
                        .join(" ")}
                    </code>
                  ) : (
                    mcpServer.url
                  )}
                </p>
                <dl className="meta meta-wide">
                  <div>
                    <dt>Capabilities</dt>
                    <dd>{capabilityNames(mcpServer.capabilities) || "none"}</dd>
                  </div>
                  <div>
                    <dt>Authentication</dt>
                    <dd>
                      {mcpServer.auth?.kind ?? "none"}
                      {mcpServer.hasApiKey ? ", credential configured" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Timeouts</dt>
                    <dd>
                      {mcpServer.capabilities?.connectTimeoutMs ?? "-"}ms /{" "}
                      {mcpServer.capabilities?.requestTimeoutMs ?? "-"}ms
                    </dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{when(mcpServer.updatedAt)}</dd>
                  </div>
                </dl>
              </div>
              <div className="card-actions">
                <Link to={`/mcp-servers/${mcpServer.id}/edit`}>Edit</Link>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(mcpServer)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

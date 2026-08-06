import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Loading, when } from "../components/Bits.jsx";

export function AgentsPage() {
  const [agents, setAgents] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const result = await api.listAgents({ q });
      setAgents(result.agents ?? []);
    } catch (caught) {
      setError(caught);
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const remove = async (agent) => {
    if (!window.confirm('Delete "' + agent.name + '"? Existing run and chat records are kept.')) {
      return;
    }
    try {
      await api.deleteAgent(agent.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="eyebrow">Build</span>
          <h1>Agents</h1>
          <p className="muted">
            Compose a model provider, local tools, MCP servers, and skills into a runnable definition.
          </p>
        </div>
        <div className="resource-toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search agents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search agents"
          />
          <Link to="/agents/new" className="button-link primary">
            New agent
          </Link>
        </div>
      </div>

      <ErrorNote error={error} />

      {agents === null ? (
        <Loading what="agents" />
      ) : agents.length === 0 ? (
        <div className="empty-state">
          <span aria-hidden="true">A</span>
          <h2>No agents found</h2>
          <p>
            {query
              ? "Try a different search."
              : "Create an agent after connecting a model provider."}
          </p>
          {!query && (
            <Link to="/agents/new" className="button-link primary">
              Create agent
            </Link>
          )}
        </div>
      ) : (
        <ul className="card-grid agent-grid">
          {agents.map((agent) => {
            const provider = agent.resolved?.modelProvider;
            const issues = agent.resolved?.issues ?? [];
            return (
              <li key={agent.id} className="card agent-card">
                <div className="card-head">
                  <div className="agent-title">
                    <span className="agent-avatar" aria-hidden="true">
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <Link to={"/agents/" + agent.id} className="card-title">
                        {agent.name}
                      </Link>
                      <span>{provider?.name ?? "No model provider"}</span>
                    </div>
                  </div>
                  <span className="resource-badges">
                    {agent.isDefault && <span className="pill pill-plan">default</span>}
                    <span className={agent.enabled ? "pill pill-success" : "pill"}>
                      {agent.enabled ? "enabled" : "disabled"}
                    </span>
                  </span>
                </div>

                <p className="card-body">{agent.description || "No description."}</p>

                <dl className="meta">
                  <div>
                    <dt>Model</dt>
                    <dd>{agent.model ?? provider?.model ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Tools</dt>
                    <dd>{agent.tools?.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>MCP</dt>
                    <dd>{agent.mcpServerIds?.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Skills</dt>
                    <dd>{agent.skills?.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{when(agent.updatedAt ?? agent.createdAt)}</dd>
                  </div>
                </dl>

                {agent.resolved?.ready === false && (
                  <p className="warn compact-warn">
                    {issues[0]?.message ?? issues[0] ?? "Configuration needs attention."}
                  </p>
                )}

                <div className="card-actions">
                  <Link to={"/chat/" + agent.id}>Chat</Link>
                  <Link to={"/agents/" + agent.id}>Open</Link>
                  <Link to={"/agents/" + agent.id + "/edit"}>Edit</Link>
                  <button type="button" className="danger" onClick={() => remove(agent)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

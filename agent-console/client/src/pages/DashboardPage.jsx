import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";

const countCards = [
  { key: "agents", label: "Agents", to: "/agents", detail: "Runnable definitions" },
  {
    key: "modelProviders",
    label: "Models",
    to: "/model-providers",
    detail: "Provider connections",
  },
  {
    key: "mcpServers",
    label: "MCP servers",
    to: "/mcp-servers",
    detail: "Tool integrations",
  },
  { key: "skills", label: "Skills", to: "/skills", detail: "Reusable instructions" },
];

export function DashboardPage() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.dashboard(), api.listAgents()])
      .then(([summary, agentResult]) => {
        if (cancelled) return;
        setDashboard(summary.dashboard ?? summary);
        const found = agentResult.agents ?? [];
        setAgents(found);
        const preferred = found.find((agent) => agent.isDefault && agent.enabled);
        setSelectedAgent((preferred ?? found.find((agent) => agent.enabled) ?? found[0])?.id ?? "");
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!dashboard && !error) return <Loading what="workspace" />;

  const counts = dashboard?.counts ?? {};
  const recentRuns = dashboard?.recentRuns ?? [];
  const recentChats = dashboard?.recentChats ?? [];

  return (
    <section className="dashboard-page">
      <div className="page-head page-head-large">
        <div>
          <span className="eyebrow">Workspace overview</span>
          <h1>Build, connect, and run your agents</h1>
          <p className="muted">
            Configure the pieces once, compose them into an agent, then test the result in chat.
          </p>
        </div>
        <Link to="/agents/new" className="button-link primary">
          New agent
        </Link>
      </div>

      <ErrorNote error={error} />

      <div className="stat-grid">
        {countCards.map((card) => (
          <Link className="stat-card" to={card.to} key={card.key}>
            <span className="stat-label">{card.label}</span>
            <strong>{counts[card.key] ?? 0}</strong>
            <span className="stat-detail">{card.detail}</span>
          </Link>
        ))}
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-primary">
          <div className="launch-card">
            <div>
              <span className="eyebrow">Agent playground</span>
              <h2>What do you want your agent to do?</h2>
              <p className="muted">
                Choose an enabled agent and open a clean, persisted chat session.
              </p>
            </div>
            {agents.length ? (
              <div className="launch-actions">
                <select
                  aria-label="Agent to chat with"
                  value={selectedAgent}
                  onChange={(event) => setSelectedAgent(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id} disabled={!agent.enabled}>
                      {agent.name}
                      {!agent.enabled ? " (disabled)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="primary"
                  disabled={!selectedAgent}
                  onClick={() => navigate(`/chat/${selectedAgent}`)}
                >
                  Start chatting
                </button>
              </div>
            ) : (
              <p className="empty compact-empty">
                Create an agent after adding a model provider.
              </p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Recent runs</h2>
                <p className="muted">Latest AgentCore activity across this workspace.</p>
              </div>
              <Link to="/runs">View all</Link>
            </div>
            {recentRuns.length ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Status</th>
                      <th>Tokens</th>
                      <th>Duration</th>
                      <th>When</th>
                      <th>
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td>{run.agentName}</td>
                        <td>
                          <StatusPill status={run.status} />
                        </td>
                        <td>{tokens(run.usage)}</td>
                        <td>{duration(run.durationMs)}</td>
                        <td>{when(run.createdAt)}</td>
                        <td>
                          <Link to={`/runs/${run.id}`}>Open</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty compact-empty">No runs yet.</p>
            )}
          </div>
        </div>

        <aside className="dashboard-aside">
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Setup</h2>
                <p className="muted">The shortest path to a first answer.</p>
              </div>
            </div>
            <ol className="setup-list">
              <SetupStep
                complete={(counts.modelProviders ?? 0) > 0}
                label="Connect a model"
                to="/model-providers/new"
              />
              <SetupStep
                complete={(counts.agents ?? 0) > 0}
                label="Create an agent"
                to="/agents/new"
              />
              <SetupStep
                complete={(counts.chats ?? 0) > 0}
                label="Start a chat"
                to="/chat"
              />
            </ol>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Recent chats</h2>
                <p className="muted">Jump back into a saved thread.</p>
              </div>
              <Link to="/chat">All chats</Link>
            </div>
            {recentChats.length ? (
              <ul className="simple-list">
                {recentChats.slice(0, 5).map((chat) => (
                  <li key={chat.id}>
                    <Link to={`/chat/${chat.agentId}?chat=${chat.id}`}>
                      <strong>{chat.title || chat.agentName}</strong>
                      <span>
                        {chat.agentName} · {when(chat.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty compact-empty">No saved chats yet.</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function SetupStep({ complete, label, to }) {
  return (
    <li className={complete ? "setup-step setup-complete" : "setup-step"}>
      <span aria-hidden="true">{complete ? "✓" : "•"}</span>
      <Link to={to}>{label}</Link>
    </li>
  );
}

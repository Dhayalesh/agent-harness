import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";

export function AgentDetailPage() {
  const { id } = useParams();
  const [agent, setAgent] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runCount, setRunCount] = useState(0);
  const [chatCount, setChatCount] = useState(0);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [agentResult, runResult] = await Promise.all([
        api.getAgent(id),
        api.listRuns({ agentId: id, limit: 10 }),
      ]);
      setAgent(agentResult.agent);
      setRunCount(
        agentResult.runCount ?? runResult.total ?? runResult.runs?.length ?? 0,
      );
      setChatCount(agentResult.chatCount ?? 0);
      setRuns(runResult.runs ?? []);
    } catch (caught) {
      setError(caught);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!agent)
    return error ? <ErrorNote error={error} /> : <Loading what="agent" />;

  const resolved = agent.resolved ?? {};
  const provider = resolved.modelProvider;
  const mcpServers = resolved.mcpServers ?? [];
  const skills = resolved.skills ?? [];
  const issues = resolved.issues ?? [];

  return (
    <section>
      <div className="page-head">
        <div className="agent-title agent-title-large">
          <span className="agent-avatar agent-avatar-large" aria-hidden="true">
            {agent.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <span className="eyebrow">Agent</span>
            <h1>{agent.name}</h1>
            <p className="muted">{agent.description || "No description."}</p>
          </div>
        </div>
        <div className="page-actions">
          <Link to={"/chat/" + agent.id} className="button-link primary">
            Open chat
          </Link>
          <Link to={"/agents/" + id + "/edit"} className="button-link">
            Edit
          </Link>
        </div>
      </div>

      <ErrorNote error={error} />

      {resolved.ready === false && (
        <div className="warn">
          <strong>This agent is not ready to run.</strong>
          <ul>
            {issues.map((issue, index) => (
              <li key={issue.code ?? index}>
                {issue.message ?? String(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-stat-grid">
        <div>
          <span>Status</span>
          <strong>{agent.enabled ? "Enabled" : "Disabled"}</strong>
        </div>
        <div>
          <span>Model</span>
          <strong>{agent.model ?? provider?.model ?? "—"}</strong>
        </div>
        <div>
          <span>Runs</span>
          <strong>{runCount}</strong>
        </div>
        <div>
          <span>Chats</span>
          <strong>{chatCount}</strong>
        </div>
      </div>

      <div className="split detail-split">
        <div>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Configuration</h2>
                <p className="muted">
                  The stored definition resolved for AgentCore.
                </p>
              </div>
              <span className={agent.enabled ? "pill pill-success" : "pill"}>
                {agent.enabled ? "enabled" : "disabled"}
              </span>
            </div>
            <dl className="meta meta-wide">
              <div>
                <dt>Provider</dt>
                <dd>
                  {provider?.id ? (
                    <Link to={"/model-providers/" + provider.id + "/edit"}>
                      {provider.name}
                    </Link>
                  ) : (
                    agent.modelProviderId
                  )}
                </dd>
              </div>
              <div>
                <dt>Provider type</dt>
                <dd>{provider?.provider ?? "—"}</dd>
              </div>
              <div>
                <dt>Default</dt>
                <dd>{agent.isDefault ? "yes" : "no"}</dd>
              </div>
              <div>
                <dt>Max turns</dt>
                <dd>{agent.limits?.maxTurns ?? "—"}</dd>
              </div>
              <div>
                <dt>Input ceiling</dt>
                <dd>
                  {agent.limits?.maxInputTokens?.toLocaleString?.() ??
                    "provider default"}
                </dd>
              </div>
              <div>
                <dt>Output ceiling</dt>
                <dd>
                  {agent.limits?.maxOutputTokens?.toLocaleString?.() ??
                    "provider default"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>System prompt</h2>
                <p className="muted">Sent at the start of every turn.</p>
              </div>
            </div>
            <pre className="prompt">{agent.systemPrompt}</pre>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Tools</h2>
                <p className="muted">
                  {agent.tools?.length ?? 0} local tools selected.
                </p>
              </div>
            </div>
            {agent.tools?.length ? (
              <div className="chip-list">
                {agent.tools.map((tool) => (
                  <code className="chip" key={tool}>
                    {tool}
                  </code>
                ))}
              </div>
            ) : (
              <p className="muted">No local tools.</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Integrations</h2>
                <p className="muted">MCP servers and reusable skills.</p>
              </div>
            </div>
            <h3>MCP servers</h3>
            {mcpServers.length ? (
              <ul className="simple-list bordered-list">
                {mcpServers.map((server) => (
                  <li key={server.id}>
                    <span>
                      <strong>
                        {server.missing ? (
                          server.id
                        ) : (
                          <Link to={"/mcp-servers/" + server.id + "/edit"}>
                            {server.name}
                          </Link>
                        )}
                      </strong>
                      <small>{server.transport}</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No MCP servers.</p>
            )}
            <h3>Skills</h3>
            {skills.length ? (
              <ul className="simple-list bordered-list">
                {skills.map((skill) => (
                  <li key={skill.id}>
                    <span>
                      <strong>
                        {skill.missing ? (
                          skill.id
                        ) : (
                          <Link to={"/skills/" + skill.id + "/edit"}>
                            {skill.name}
                          </Link>
                        )}
                      </strong>
                      <small>{skill.uri}</small>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No skills.</p>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Recent runs</h2>
            <p className="muted">Latest turns executed by this definition.</p>
          </div>
          <Link to="/runs">View all</Link>
        </div>
        {runs.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Status</th>
                  <th>Turns</th>
                  <th>Tokens</th>
                  <th>Duration</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{when(run.createdAt)}</td>
                    <td>
                      <StatusPill status={run.status} />
                    </td>
                    <td>{run.turns}</td>
                    <td>{tokens(run.usage)}</td>
                    <td>{duration(run.durationMs)}</td>
                    <td>
                      <Link to={"/runs/" + run.id}>Open</Link>
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
    </section>
  );
}

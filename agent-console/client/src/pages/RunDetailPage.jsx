import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";

export function RunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    void api
      .getRun(id)
      .then(({ run: found }) => setRun(found))
      .catch(setError);
  }, [id]);

  if (!run) return error ? <ErrorNote error={error} /> : <Loading what="run" />;

  const remove = async () => {
    if (!window.confirm("Delete this run record?")) return;
    try {
      await api.deleteRun(id);
      navigate("/runs");
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>
            Run <StatusPill status={run.status} />
          </h1>
          <p className="muted">
            {run.agentName} · {when(run.createdAt)}
          </p>
        </div>
        <span>
          <Link to={`/agents/${run.agentId}`}>Open agent</Link>
          <button type="button" className="danger" onClick={remove}>
            Delete
          </button>
        </span>
      </div>

      <ErrorNote error={error} />

      <dl className="meta meta-wide">
        <div>
          <dt>Turns</dt>
          <dd>{run.turns}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{tokens(run.usage)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration(run.durationMs)}</dd>
        </div>
        <div>
          <dt>Stop reason</dt>
          <dd>{run.stopReason ?? "—"}</dd>
        </div>
        <div>
          <dt>Runtime session id</dt>
          <dd>
            {/* Reuse this for AgentCore affinity and the same runtime workspace. */}
            <code className="clip">{run.runtimeSessionId ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>Trace id</dt>
          <dd>
            <code className="clip">{run.traceId ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>Runtime</dt>
          <dd>
            <code className="clip">{run.agentRuntimeArn ?? "—"}</code>
          </dd>
        </div>
        <div>
          <dt>Qualifier</dt>
          <dd>{run.agentRuntimeQualifier ?? "—"}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>
            <code className="clip">{run.workingDirectory ?? "—"}</code>
          </dd>
        </div>
      </dl>

      {run.error && (
        <p className="warn">
          <strong>{run.error.code}</strong> {run.error.message}
          {run.error.recoverable ? " (recoverable)" : ""}
        </p>
      )}

      <h2>Prompt</h2>
      <pre className="prompt">{run.prompt}</pre>

      <h2>Output</h2>
      <pre className="output">{run.output || "(no text output)"}</pre>

      <h2>Tool usage</h2>
      {run.tools?.length ? (
        <table className="table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Calls</th>
              <th>Errors</th>
            </tr>
          </thead>
          <tbody>
            {run.tools.map((tool) => (
              <tr key={tool.name}>
                <td>
                  <code>{tool.name}</code>
                </td>
                <td>{tool.calls}</td>
                <td>{tool.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No tools were called.</p>
      )}

      <h2>Token detail</h2>
      <pre className="json">{JSON.stringify(run.usage ?? {}, null, 2)}</pre>
    </section>
  );
}

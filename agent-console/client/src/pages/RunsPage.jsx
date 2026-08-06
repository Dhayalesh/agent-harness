import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";

export function RunsPage() {
  const [runs, setRuns] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { runs: found } = await api.listRuns({
        status: status || undefined,
        limit: 100,
      });
      setRuns(found);
    } catch (caught) {
      setError(caught);
      setRuns([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="muted">
            Every AgentCore invocation this console sent, with what it cost. The
            runtime keeps none of this — the row is written here.
          </p>
        </div>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">all statuses</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="running">running</option>
        </select>
      </div>

      <ErrorNote error={error} />

      {runs === null ? (
        <Loading what="runs" />
      ) : runs.length === 0 ? (
        <p className="empty">No runs recorded.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Prompt</th>
              <th>Status</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Duration</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{when(run.createdAt)}</td>
                <td>{run.agentName}</td>
                <td className="clip">{run.prompt}</td>
                <td>
                  <StatusPill status={run.status} />
                </td>
                <td>{run.turns}</td>
                <td>{tokens(run.usage)}</td>
                <td>{duration(run.durationMs)}</td>
                <td>
                  <Link to={`/runs/${run.id}`}>Open</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

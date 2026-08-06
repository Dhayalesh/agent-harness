import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  when,
} from "../components/Bits.jsx";

export function ModelProvidersPage() {
  const [modelProviders, setModelProviders] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const { modelProviders: found } = await api.listModelProviders({ q });
      setModelProviders(found);
    } catch (caught) {
      setError(caught);
      setModelProviders([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // The API may implement q server-side; filtering again keeps search functional
  // against older console servers that simply return the whole collection.
  const visibleModelProviders = useMemo(() => {
    if (!modelProviders || !query.trim()) return modelProviders;
    const needle = query.trim().toLowerCase();
    return modelProviders.filter((modelProvider) =>
      [modelProvider.name, modelProvider.provider, modelProvider.model]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [modelProviders, query]);

  const remove = async (modelProvider) => {
    const confirmed = window.confirm(
      `Delete model provider "${modelProvider.name}"? Agents that reference it must be updated first.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteModelProvider(modelProvider.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Model providers</h1>
          <p className="muted">
            Reusable model endpoints and capability limits sent to the AgentCore
            runtime with an invocation.
          </p>
        </div>
        <div className="resource-toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search providers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search model providers"
          />
          <Link to="/model-providers/new">New provider</Link>
        </div>
      </div>

      <ErrorNote error={error} />

      {modelProviders === null ? (
        <Loading what="model providers" />
      ) : visibleModelProviders.length === 0 ? (
        <p className="empty">
          {query
            ? "No model providers match this search."
            : "No model providers found."}{" "}
          {!query && <Link to="/model-providers/new">Create one</Link>}
          {!query && "."}
        </p>
      ) : (
        <ul className="resource-list">
          {visibleModelProviders.map((modelProvider) => (
            <li key={modelProvider.id} className="resource-row">
              <div className="resource-summary">
                <div className="resource-title-row">
                  <strong>{modelProvider.name}</strong>
                  <span className="resource-badges">
                    <span className={`pill pill-${modelProvider.provider}`}>
                      {modelProvider.provider}
                    </span>
                    <StatusPill
                      status={modelProvider.enabled ? "enabled" : "disabled"}
                    />
                    {modelProvider.isDefault && <StatusPill status="default" />}
                  </span>
                </div>
                <p className="muted">
                  <code>{modelProvider.model}</code>
                  {" via "}
                  {modelProvider.baseURL || "the OpenRouter default endpoint"}
                </p>
                <dl className="meta meta-wide">
                  <div>
                    <dt>Context</dt>
                    <dd>
                      {modelProvider.capabilities?.contextWindow?.toLocaleString() ??
                        "-"}{" "}
                      tokens
                    </dd>
                  </div>
                  <div>
                    <dt>Max output</dt>
                    <dd>
                      {modelProvider.capabilities?.maxOutputTokens?.toLocaleString() ??
                        "-"}{" "}
                      tokens
                    </dd>
                  </div>
                  <div>
                    <dt>Credential</dt>
                    <dd>{modelProvider.hasApiKey ? "configured" : "missing"}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{when(modelProvider.updatedAt)}</dd>
                  </div>
                </dl>
              </div>
              <div className="card-actions">
                <Link to={`/model-providers/${modelProvider.id}/edit`}>
                  Edit
                </Link>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(modelProvider)}
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

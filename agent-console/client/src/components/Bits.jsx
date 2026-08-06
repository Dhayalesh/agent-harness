/** Small presentational pieces shared by the pages. */

export function StatusPill({ status }) {
  return <span className={`pill pill-${status}`}>{status}</span>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <strong>{error.message}</strong>
      {error.details?.length > 0 && (
        <ul>
          {error.details.map((detail) => (
            <li key={`${detail.field}-${detail.message}`}>
              <code>{detail.field}</code> {detail.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ what = "data" }) {
  return <p className="empty">Loading {what}…</p>;
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/** Milliseconds as something a person reads at a glance. */
export function duration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function when(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function tokens(usage) {
  if (!usage) return "—";
  const total =
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (!total) return "—";
  return `${total.toLocaleString()} tok`;
}

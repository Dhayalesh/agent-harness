import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, Loading } from "../components/Bits.jsx";

const EMPTY = {
  name: "",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
  baseURL: "",
  apiKey: "",
  hasApiKey: false,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: false,
  reportsCost: true,
  headers: [],
  enabled: true,
  isDefault: false,
};

const rowsFromSecretMap = (record, names) => {
  if (record) {
    return Object.entries(record).map(([key, value]) => ({ key, value }));
  }
  return (names ?? []).map((key) => ({ key, value: "" }));
};

const secretMapFromRows = (rows) =>
  Object.fromEntries(
    rows
      .filter((row) => row.key.trim())
      .map((row) => [row.key.trim(), row.value]),
  );

function KeyValueEditor({ rows, onChange, error, editing }) {
  const setRow = (index, key, value) =>
    onChange(
      rows.map((row, position) =>
        position === index ? { ...row, [key]: value } : row,
      ),
    );

  return (
    <div className="field key-value-editor">
      <span className="field-label">Additional headers</span>
      <span className="field-hint">
        Optional static request headers. Authorization is supplied by the API
        key above.
        {editing &&
          " Existing values are hidden; leave a displayed value blank to keep it, or remove its row to clear it."}
      </span>
      {rows.map((row, index) => (
        <div className="key-value-row" key={index}>
          <input
            aria-label={`Header ${index + 1} name`}
            placeholder="Header name"
            value={row.key}
            onChange={(event) => setRow(index, "key", event.target.value)}
          />
          <input
            aria-label={`Header ${index + 1} value`}
            placeholder={
              editing && !row.value ? "stored value (unchanged)" : "Value"
            }
            value={row.value}
            onChange={(event) => setRow(index, "value", event.target.value)}
          />
          <button
            type="button"
            className="danger"
            aria-label={`Remove header ${index + 1}`}
            onClick={() =>
              onChange(rows.filter((_, position) => position !== index))
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          Add header
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function ModelProviderFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";

  const [form, setForm] = useState(editing ? null : { ...EMPTY, headers: [] });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getModelProvider(id)
      .then(({ modelProvider }) =>
        setForm({
          ...EMPTY,
          ...modelProvider,
          baseURL: modelProvider.baseURL ?? "",
          apiKey: "",
          contextWindow:
            modelProvider.capabilities?.contextWindow ?? EMPTY.contextWindow,
          maxOutputTokens:
            modelProvider.capabilities?.maxOutputTokens ??
            EMPTY.maxOutputTokens,
          supportsTools:
            modelProvider.capabilities?.supportsTools ?? EMPTY.supportsTools,
          supportsStreaming:
            modelProvider.capabilities?.supportsStreaming ??
            EMPTY.supportsStreaming,
          supportsReasoning:
            modelProvider.capabilities?.supportsReasoning ??
            EMPTY.supportsReasoning,
          reportsCost:
            modelProvider.capabilities?.reportsCost ?? EMPTY.reportsCost,
          headers: rowsFromSecretMap(
            modelProvider.headers,
            modelProvider.headerNames,
          ),
        }),
      )
      .catch(setError);
  }, [editing, id]);

  const fieldErrors = useMemo(() => {
    const map = {};
    for (const detail of error?.details ?? [])
      map[detail.field] = detail.message;
    return map;
  }, [error]);

  if (form === null)
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <Loading what="model provider" />
    );

  const set = (key) => (event) => {
    const value =
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.type === "number"
          ? event.target.value === ""
            ? ""
            : Number(event.target.value)
          : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const baseURL = form.baseURL.trim();
    const body = {
      name: form.name.trim(),
      provider: form.provider,
      model: form.model.trim(),
      // Blank is the explicit clear value on PATCH and is omitted on create.
      ...(baseURL ? { baseURL } : editing ? { baseURL: null } : {}),
      auth: { kind: "bearer" },
      capabilities: {
        contextWindow: Number(form.contextWindow),
        maxOutputTokens: Number(form.maxOutputTokens),
        supportsTools: form.supportsTools,
        supportsStreaming: form.supportsStreaming,
        supportsReasoning: form.supportsReasoning,
        reportsCost: form.reportsCost,
      },
      headers: secretMapFromRows(form.headers),
      enabled: form.enabled,
      isDefault: form.isDefault,
    };

    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();

    try {
      if (editing) await api.updateModelProvider(id, body);
      else {
        await api.createModelProvider({
          ...body,
          apiKey: form.apiKey.trim(),
        });
      }
      navigate("/model-providers");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{editing ? `Edit ${form.name}` : "New model provider"}</h1>
          <p className="muted">
            Configure the endpoint, credential, and limits the hosted runtime
            uses for model calls.
          </p>
        </div>
        <Link to="/model-providers">Cancel</Link>
      </div>

      <ErrorNote error={error} />

      <form className="form" onSubmit={submit}>
        <fieldset>
          <legend>Identity and model</legend>
          <Field
            label="Name"
            hint="Letters, digits, dot, dash, or underscore. Unique."
            error={fieldErrors.name}
          >
            <input
              value={form.name}
              onChange={set("name")}
              required
              maxLength={100}
            />
          </Field>
          <div className="row">
            <Field label="Provider" error={fieldErrors.provider}>
              <select value={form.provider} onChange={set("provider")}>
                <option value="openrouter">openrouter</option>
                <option value="openai-compatible">openai-compatible</option>
              </select>
            </Field>
            <Field label="Model" error={fieldErrors.model}>
              <input
                value={form.model}
                onChange={set("model")}
                required
                maxLength={300}
              />
            </Field>
          </div>
          <Field
            label="Base URL"
            hint={
              form.provider === "openrouter"
                ? "Optional. Blank uses OpenRouter's default endpoint."
                : "Required for an OpenAI-compatible provider."
            }
            error={fieldErrors.baseURL}
          >
            <input
              type="url"
              value={form.baseURL}
              onChange={set("baseURL")}
              placeholder="https://api.example.com/v1"
              required={form.provider === "openai-compatible"}
              spellCheck={false}
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Authentication</legend>
          <Field
            label="Authentication"
            hint="The hosted runtime supports Authorization: Bearer for model providers."
          >
            <input value="bearer" readOnly aria-readonly="true" />
          </Field>
          <Field
            label="API key"
            hint={
              editing
                ? "Blank leaves the stored key unchanged. The saved value is never returned to the browser."
                : "Required. The saved value is never returned to the browser."
            }
            error={fieldErrors.apiKey}
          >
            <input
              type="password"
              value={form.apiKey}
              onChange={set("apiKey")}
              required={!editing || !form.hasApiKey}
              autoComplete="new-password"
            />
          </Field>
          <KeyValueEditor
            rows={form.headers}
            onChange={(headers) =>
              setForm((current) => ({ ...current, headers }))
            }
            error={fieldErrors.headers}
            editing={editing}
          />
        </fieldset>

        <fieldset>
          <legend>Capabilities</legend>
          <div className="row">
            <Field
              label="Context window"
              hint="Total model context in tokens."
              error={fieldErrors["capabilities.contextWindow"]}
            >
              <input
                type="number"
                min={1}
                max={10_000_000}
                value={form.contextWindow}
                onChange={set("contextWindow")}
                required
              />
            </Field>
            <Field
              label="Max output tokens"
              hint="Must be smaller than the context window."
              error={fieldErrors["capabilities.maxOutputTokens"]}
            >
              <input
                type="number"
                min={1}
                max={10_000_000}
                value={form.maxOutputTokens}
                onChange={set("maxOutputTokens")}
                required
              />
            </Field>
          </div>
          <div className="toggle-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.supportsTools}
                onChange={set("supportsTools")}
              />
              Supports tools
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.supportsStreaming}
                onChange={set("supportsStreaming")}
              />
              Supports streaming
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.supportsReasoning}
                onChange={set("supportsReasoning")}
              />
              Supports reasoning
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.reportsCost}
                onChange={set("reportsCost")}
              />
              Reports cost
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Availability</legend>
          <div className="toggle-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={set("enabled")}
              />
              Enabled
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={set("isDefault")}
              />
              Default provider
            </label>
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving
              ? "Saving..."
              : editing
                ? "Save changes"
                : "Create provider"}
          </button>
          <Link to="/model-providers">Cancel</Link>
        </div>
      </form>
    </section>
  );
}

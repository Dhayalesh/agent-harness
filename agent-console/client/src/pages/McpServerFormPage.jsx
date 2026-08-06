import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, Loading } from "../components/Bits.jsx";

const EMPTY = {
  name: "",
  transport: "http",
  originalTransport: "http",
  command: "",
  args: [],
  env: [],
  url: "",
  authKind: "bearer",
  headerName: "",
  apiKey: "",
  hasApiKey: false,
  headers: [],
  tools: true,
  resources: false,
  prompts: false,
  elicitation: false,
  connectTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  enabled: true,
  autoConnect: false,
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

function KeyValueEditor({
  label,
  hint,
  addLabel,
  keyPlaceholder,
  rows,
  onChange,
  error,
  editing,
}) {
  const setRow = (index, key, value) =>
    onChange(
      rows.map((row, position) =>
        position === index ? { ...row, [key]: value } : row,
      ),
    );

  return (
    <div className="field key-value-editor">
      <span className="field-label">{label}</span>
      <span className="field-hint">
        {hint}
        {editing &&
          " Existing values are hidden; leave a displayed value blank to keep it, or remove its row to clear it."}
      </span>
      {rows.map((row, index) => (
        <div className="key-value-row" key={index}>
          <input
            aria-label={`${label} ${index + 1} name`}
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(event) => setRow(index, "key", event.target.value)}
          />
          <input
            aria-label={`${label} ${index + 1} value`}
            placeholder={
              editing && !row.value ? "stored value (unchanged)" : "Value"
            }
            value={row.value}
            onChange={(event) => setRow(index, "value", event.target.value)}
          />
          <button
            type="button"
            className="danger"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
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
          {addLabel}
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function StringListEditor({ values, onChange, error }) {
  return (
    <div className="field string-list-editor">
      <span className="field-label">Arguments</span>
      <span className="field-hint">
        Each row is passed to the command as one argument, in order. For
        example, npx uses separate rows for -y, @scope/package, and
        --transport=stdio. Put an MCP endpoint URL under HTTP transport instead
        of in npx's package row.
      </span>
      {values.map((value, index) => (
        <div className="key-value-row" key={index}>
          <input
            aria-label={`Argument ${index + 1}`}
            value={value}
            onChange={(event) =>
              onChange(
                values.map((entry, position) =>
                  position === index ? event.target.value : entry,
                ),
              )
            }
          />
          <button
            type="button"
            className="danger"
            aria-label={`Remove argument ${index + 1}`}
            onClick={() =>
              onChange(values.filter((_, position) => position !== index))
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button type="button" onClick={() => onChange([...values, ""])}>
          Add argument
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function McpServerFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";

  const [form, setForm] = useState(
    editing ? null : { ...EMPTY, args: [], env: [], headers: [] },
  );
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getMcpServer(id)
      .then(({ mcpServer }) =>
        setForm({
          ...EMPTY,
          ...mcpServer,
          originalTransport: mcpServer.transport,
          command: mcpServer.command ?? "",
          args: mcpServer.args ?? [],
          env: rowsFromSecretMap(mcpServer.env, mcpServer.envKeys),
          url: mcpServer.url ?? "",
          authKind:
            mcpServer.transport === "stdio"
              ? "none"
              : (mcpServer.auth?.kind ?? "bearer"),
          headerName: mcpServer.auth?.headerName ?? "",
          apiKey: "",
          headers: rowsFromSecretMap(mcpServer.headers, mcpServer.headerNames),
          tools: mcpServer.capabilities?.tools ?? EMPTY.tools,
          resources: mcpServer.capabilities?.resources ?? EMPTY.resources,
          prompts: mcpServer.capabilities?.prompts ?? EMPTY.prompts,
          elicitation: mcpServer.capabilities?.elicitation ?? EMPTY.elicitation,
          connectTimeoutMs:
            mcpServer.capabilities?.connectTimeoutMs ?? EMPTY.connectTimeoutMs,
          requestTimeoutMs:
            mcpServer.capabilities?.requestTimeoutMs ?? EMPTY.requestTimeoutMs,
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
    return error ? <ErrorNote error={error} /> : <Loading what="MCP server" />;

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

  const changeTransport = (event) => {
    const transport = event.target.value;
    setForm((current) => {
      const firstArgument = current.args[0]?.trim() ?? "";
      const url =
        transport === "http" &&
        !current.url &&
        /^https?:\/\//i.test(firstArgument)
          ? firstArgument
          : current.url;
      return {
        ...current,
        transport,
        url,
        authKind: transport === "stdio" ? "none" : "bearer",
      };
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const body = {
      name: form.name.trim(),
      transport: form.transport,
      capabilities: {
        tools: form.tools,
        resources: form.resources,
        prompts: form.prompts,
        elicitation: form.elicitation,
        connectTimeoutMs: Number(form.connectTimeoutMs),
        requestTimeoutMs: Number(form.requestTimeoutMs),
      },
      enabled: form.enabled,
      autoConnect: form.autoConnect,
    };

    if (form.transport === "stdio") {
      Object.assign(body, {
        command: form.command.trim(),
        args: form.args.filter((argument) => argument !== ""),
        env: secretMapFromRows(form.env),
        auth: { kind: "none" },
      });
      if (editing) {
        Object.assign(body, { url: null, apiKey: null, headers: null });
      }
    } else {
      Object.assign(body, {
        url: form.url.trim(),
        auth: {
          kind: form.authKind,
          ...(form.authKind === "header"
            ? { headerName: form.headerName.trim() }
            : {}),
        },
        headers: secretMapFromRows(form.headers),
      });
      if (editing) {
        Object.assign(body, { command: null, args: null, env: null });
      }
      if (form.authKind === "none") {
        if (editing) body.apiKey = null;
      } else if (form.apiKey.trim()) {
        body.apiKey = form.apiKey.trim();
      }
    }

    if (editing && form.transport !== form.originalTransport) body.wire = null;

    try {
      const requestBody =
        editing || form.transport === "stdio" || form.authKind === "none"
          ? body
          : { ...body, apiKey: form.apiKey.trim() };
      if (editing) await api.updateMcpServer(id, requestBody);
      else await api.createMcpServer(requestBody);
      navigate("/mcp-servers");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const apiKeyRequired =
    form.transport === "http" &&
    form.authKind !== "none" &&
    (!editing || !form.hasApiKey);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>{editing ? `Edit ${form.name}` : "New MCP server"}</h1>
          <p className="muted">
            Configure a stdio process or HTTP endpoint the hosted runtime can
            connect to.
          </p>
        </div>
        <Link to="/mcp-servers">Cancel</Link>
      </div>

      <ErrorNote error={error} />

      <form className="form" onSubmit={submit}>
        <fieldset>
          <legend>Identity and transport</legend>
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
          <Field label="Transport" error={fieldErrors.transport}>
            <select value={form.transport} onChange={changeTransport}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </Field>

          {form.transport === "stdio" ? (
            <>
              <Field
                label="Command"
                hint="Executable available inside the AgentCore runtime image."
                error={fieldErrors.command}
              >
                <input
                  value={form.command}
                  onChange={set("command")}
                  required
                  maxLength={1000}
                  spellCheck={false}
                />
              </Field>
              <StringListEditor
                values={form.args}
                onChange={(args) =>
                  setForm((current) => ({ ...current, args }))
                }
                error={fieldErrors.args}
              />
              <KeyValueEditor
                label="Environment variables"
                hint="Variables passed only to the spawned MCP process."
                addLabel="Add variable"
                keyPlaceholder="Variable name"
                rows={form.env}
                onChange={(env) => setForm((current) => ({ ...current, env }))}
                error={fieldErrors.env}
                editing={editing}
              />
              <p className="field-hint">
                stdio uses no HTTP authentication. Pass process credentials
                through environment variables.
              </p>
            </>
          ) : (
            <>
              <Field
                label="URL"
                hint="The HTTP MCP endpoint. HTTPS is recommended."
                error={fieldErrors.url}
              >
                <input
                  type="url"
                  value={form.url}
                  onChange={set("url")}
                  required
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                />
              </Field>
              <div className="row">
                <Field label="Authentication" error={fieldErrors["auth.kind"]}>
                  <select value={form.authKind} onChange={set("authKind")}>
                    <option value="bearer">bearer</option>
                    <option value="header">custom header</option>
                    <option value="none">none</option>
                  </select>
                </Field>
                {form.authKind === "header" && (
                  <Field
                    label="Authentication header"
                    hint="The API key is sent as this header's value."
                    error={fieldErrors["auth.headerName"]}
                  >
                    <input
                      value={form.headerName}
                      onChange={set("headerName")}
                      required
                      maxLength={100}
                      placeholder="X-API-Key"
                    />
                  </Field>
                )}
              </div>
              {form.authKind !== "none" && (
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
                    required={apiKeyRequired}
                    autoComplete="new-password"
                  />
                </Field>
              )}
              <KeyValueEditor
                label="Additional headers"
                hint="Optional static HTTP headers. Do not duplicate the authentication header."
                addLabel="Add header"
                keyPlaceholder="Header name"
                rows={form.headers}
                onChange={(headers) =>
                  setForm((current) => ({ ...current, headers }))
                }
                error={fieldErrors.headers}
                editing={editing}
              />
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Capabilities and timeouts</legend>
          <p className="field-hint">
            At least one of tools, resources, or prompts must be enabled.
          </p>
          <div className="toggle-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.tools}
                onChange={set("tools")}
              />
              Tools
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.resources}
                onChange={set("resources")}
              />
              Resources
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.prompts}
                onChange={set("prompts")}
              />
              Prompts
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.elicitation}
                onChange={set("elicitation")}
              />
              Elicitation
            </label>
          </div>
          {fieldErrors["capabilities.tools"] && (
            <span className="field-error">
              {fieldErrors["capabilities.tools"]}
            </span>
          )}
          <div className="row">
            <Field
              label="Connect timeout (ms)"
              hint="Budget for the initialize handshake."
              error={fieldErrors["capabilities.connectTimeoutMs"]}
            >
              <input
                type="number"
                min={1}
                max={600_000}
                value={form.connectTimeoutMs}
                onChange={set("connectTimeoutMs")}
                required
              />
            </Field>
            <Field
              label="Request timeout (ms)"
              hint="Budget for each request after connection."
              error={fieldErrors["capabilities.requestTimeoutMs"]}
            >
              <input
                type="number"
                min={1}
                max={600_000}
                value={form.requestTimeoutMs}
                onChange={set("requestTimeoutMs")}
                required
              />
            </Field>
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
                checked={form.autoConnect}
                onChange={set("autoConnect")}
              />
              Auto-connect for runs
            </label>
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving
              ? "Saving..."
              : editing
                ? "Save changes"
                : "Create MCP server"}
          </button>
          <Link to="/mcp-servers">Cancel</Link>
        </div>
      </form>
    </section>
  );
}

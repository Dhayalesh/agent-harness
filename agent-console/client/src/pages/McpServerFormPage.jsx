import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, ToggleCard } from "../components/Bits.jsx";
import {
  FormActionBar,
  FormBody,
  FormSection,
} from "../components/FormLayout.jsx";
import {
  KeyValueEditor,
  StringListEditor,
  rowsFromSecretMap,
  secretMapFromRows,
} from "../components/MapEditor.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EDGE_URL = "wss://edge-server-conector.duckdns.org/harness/ws";

const EMPTY = {
  name: "",
  transport: "http",
  originalTransport: "http",
  command: "",
  args: [],
  env: [],
  url: "",
  httpUrl: "",
  edgeUrl: EDGE_URL,
  mcpId: "sap-adt",
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

export function McpServerFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";

  const { toast } = useToast();

  const [form, setForm] = useState(
    editing ? null : { ...EMPTY, args: [], env: [], headers: [] },
  );
  // Snapshot of the loaded record, so the save bar reports whether anything
  // actually changed rather than always offering to save.
  const [baseline, setBaseline] = useState(
    editing ? null : { ...EMPTY, args: [], env: [], headers: [] },
  );
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getMcpServer(id)
      .then(({ mcpServer }) => {
        const loaded = {
          ...EMPTY,
          ...mcpServer,
          originalTransport: mcpServer.transport,
          command: mcpServer.command ?? "",
          args: mcpServer.args ?? [],
          env: rowsFromSecretMap(mcpServer.env, mcpServer.envKeys),
          url: mcpServer.url ?? "",
          httpUrl:
            mcpServer.transport === "http" ? (mcpServer.url ?? "") : "",
          edgeUrl:
            mcpServer.transport === "edge"
              ? (mcpServer.url ?? EDGE_URL)
              : EDGE_URL,
          mcpId: mcpServer.mcpId ?? EMPTY.mcpId,
          authKind:
            mcpServer.transport !== "http"
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
        };
        setForm(loaded);
        setBaseline(loaded);
      })
      .catch(setError);
  }, [editing, id]);

  const fieldErrors = useMemo(() => {
    const map = {};
    for (const detail of error?.details ?? [])
      map[detail.field] = detail.message;
    return map;
  }, [error]);

  // A create form is dirty from the start; there is nothing saved to match.
  const dirty = useMemo(
    () => !editing || JSON.stringify(form) !== JSON.stringify(baseline),
    [editing, form, baseline],
  );

  if (form === null)
    return error ? <ErrorNote error={error} /> : <SkeletonPanels count={3} />;

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setNumber = (key) => (value) =>
    setForm((current) => ({
      ...current,
      [key]: value === "" ? "" : Number(value),
    }));

  const changeTransport = (transport) => {
    setForm((current) => {
      const firstArgument = current.args[0]?.trim() ?? "";
      const urls = {
        ...current,
        ...(current.transport === "http" ? { httpUrl: current.url } : {}),
        ...(current.transport === "edge" ? { edgeUrl: current.url } : {}),
      };
      let url = current.url;
      if (transport === "edge") url = urls.edgeUrl || EDGE_URL;
      if (transport === "http") {
        url =
          urls.httpUrl ||
          (/^https?:\/\//i.test(firstArgument) ? firstArgument : "");
      }
      return {
        ...urls,
        transport,
        url,
        authKind: transport === "http" ? "bearer" : "none",
      };
    });
  };

  const changeAuth = (authKind) => setForm((current) => ({
    ...current, authKind,
  }));

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
        if (form.originalTransport === "edge") body.mcpId = null;
      }
    } else if (form.transport === "edge") {
      Object.assign(body, {
        url: form.url.trim(),
        mcpId: form.mcpId.trim(),
        auth: { kind: "none" },
      });
      if (editing) {
        Object.assign(body, {
          command: null,
          args: null,
          env: null,
          apiKey: null,
          headers: null,
        });
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
        if (form.originalTransport === "edge") body.mcpId = null;
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
      await (editing ? api.updateMcpServer(id, requestBody) : api.createMcpServer(requestBody));
      toast({
        title: editing ? "MCP server updated" : "MCP server created",
        description: requestBody.name,
      });
      navigate("/mcp-servers");
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not save MCP server",
        description: caught.message,
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  const apiKeyRequired =
    form.transport === "http" &&
    ["bearer", "header"].includes(form.authKind) &&
    (!editing || !form.hasApiKey);

  return (
    <PageShell
      breadcrumbs={[
        { label: "Configuration" },
        { label: "MCP servers", to: "/mcp-servers" },
        { label: editing ? form.name || "Edit" : "New MCP server" },
      ]}
      title={editing ? `Edit ${form.name}` : "New MCP server"}
      description="Configure a stdio process, HTTP endpoint, or Edge server the hosted runtime can connect to."
    >
      <ErrorNote error={error} />

      <FormBody>
        <form onSubmit={submit}>
          <FormSection
            title="Identity and transport"
            description="How the runtime reaches this server: a local stdio process, HTTP endpoint, or Edge server."
          >
            <Field
              label="Name"
              htmlFor="mcp-name"
              hint="Letters, digits, dot, dash, or underscore. Unique."
              error={fieldErrors.name}
            >
              <Input
                id="mcp-name"
                required
                placeholder="github-mcp"
                maxLength={100}
                value={form.name}
                onChange={(event) => set("name")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>
            <Field
              label="Transport"
              htmlFor="mcp-transport"
              error={fieldErrors.transport}
            >
              <Select value={form.transport} onValueChange={changeTransport}>
                <SelectTrigger
                  id="mcp-transport"
                  className="md:max-w-xs"
                  aria-invalid={Boolean(fieldErrors.transport)}
                >
                  <SelectValue placeholder="Choose a transport" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem key="stdio" value="stdio">
                    stdio
                  </SelectItem>
                  <SelectItem key="http" value="http">
                    http
                  </SelectItem>
                  <SelectItem key="edge" value="edge">
                    edge
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {form.transport === "stdio" ? (
              <>
                <Field
                  label="Command"
                  htmlFor="mcp-command"
                  hint="Executable available inside the AgentCore runtime image."
                  error={fieldErrors.command}
                >
                  <Input
                    id="mcp-command"
                    required
                    placeholder="npx"
                    maxLength={1000}
                    spellCheck={false}
                    value={form.command}
                    onChange={(event) => set("command")(event.target.value)}
                    aria-invalid={Boolean(fieldErrors.command)}
                  />
                </Field>
                <StringListEditor
                  values={form.args}
                  onChange={set("args")}
                  error={fieldErrors.args}
                />
                <KeyValueEditor
                  label="Environment variables"
                  hint="Variables passed only to the spawned MCP process."
                  addLabel="Add variable"
                  keyPlaceholder="Variable name"
                  rows={form.env}
                  onChange={set("env")}
                  error={fieldErrors.env}
                  editing={editing}
                />
                <p className="text-tiny text-default-500">
                  stdio uses no HTTP authentication. Pass process credentials
                  through environment variables.
                </p>
              </>
            ) : form.transport === "edge" ? (
              <>
                <Field
                  label="Edge Server URL"
                  htmlFor="mcp-url"
                  hint="The Edge Server WebSocket endpoint."
                  error={fieldErrors.url}
                >
                  <Input
                    id="mcp-url"
                    required
                    type="url"
                    pattern="wss?://.+"
                    placeholder={EDGE_URL}
                    spellCheck={false}
                    value={form.url}
                    onChange={(event) => set("url")(event.target.value)}
                    aria-invalid={Boolean(fieldErrors.url)}
                  />
                </Field>
                <Field
                  label="MCP ID"
                  htmlFor="mcp-id"
                  error={fieldErrors.mcpId}
                >
                  <Input
                    id="mcp-id"
                    required
                    maxLength={100}
                    pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
                    placeholder="sap-adt"
                    value={form.mcpId}
                    onChange={(event) => set("mcpId")(event.target.value)}
                    aria-invalid={Boolean(fieldErrors.mcpId)}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label="URL"
                  htmlFor="mcp-url"
                  hint="The HTTP MCP endpoint. HTTPS is recommended."
                  error={fieldErrors.url}
                >
                  <Input
                    id="mcp-url"
                    required
                    type="url"
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                    value={form.url}
                    onChange={(event) => set("url")(event.target.value)}
                    aria-invalid={Boolean(fieldErrors.url)}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field
                    label="Authentication"
                    htmlFor="mcp-auth-kind"
                    error={fieldErrors["auth.kind"]}
                  >
                    <Select
                      value={form.authKind}
                      onValueChange={changeAuth}
                    >
                      <SelectTrigger
                        id="mcp-auth-kind"
                        aria-invalid={Boolean(fieldErrors["auth.kind"])}
                      >
                        <SelectValue placeholder="Choose a scheme" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem key="bearer" value="bearer">
                          bearer
                        </SelectItem>
                        <SelectItem key="header" value="header">
                          custom header
                        </SelectItem>
                        <SelectItem key="none" value="none">
                          none
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {form.authKind === "header" && (
                    <Field
                      label="Authentication header"
                      htmlFor="mcp-auth-header"
                      hint="The API key is sent as this header's value."
                      error={fieldErrors["auth.headerName"]}
                    >
                      <Input
                        id="mcp-auth-header"
                        required
                        placeholder="X-API-Key"
                        maxLength={100}
                        value={form.headerName}
                        onChange={(event) =>
                          set("headerName")(event.target.value)
                        }
                        aria-invalid={Boolean(fieldErrors["auth.headerName"])}
                      />
                    </Field>
                  )}
                </div>
                {["bearer", "header"].includes(form.authKind) && (
                  <Field
                    label="API key"
                    htmlFor="mcp-api-key"
                    hint={
                      editing
                        ? "Blank leaves the stored key unchanged."
                        : "Required. The saved value is never returned to the browser."
                    }
                    error={fieldErrors.apiKey}
                  >
                    <Input
                      id="mcp-api-key"
                      type="password"
                      placeholder={editing ? "•••••••• (unchanged)" : "Token"}
                      autoComplete="new-password"
                      required={apiKeyRequired}
                      value={form.apiKey}
                      onChange={(event) => set("apiKey")(event.target.value)}
                      aria-invalid={Boolean(fieldErrors.apiKey)}
                    />
                  </Field>
                )}
                <KeyValueEditor
                  label="Additional headers"
                  hint="Optional static HTTP headers. Do not duplicate the authentication header."
                  addLabel="Add header"
                  keyPlaceholder="Header name"
                  rows={form.headers}
                  onChange={set("headers")}
                  error={fieldErrors.headers}
                  editing={editing}
                />
              </>
            )}
          </FormSection>

          <FormSection
            title="Capabilities and timeouts"
            description="What this server is allowed to expose, and how long the runtime waits on it. At least one of tools, resources, or prompts must be enabled."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ToggleCard
                label="Tools"
                isSelected={form.tools}
                onValueChange={set("tools")}
              />
              <ToggleCard
                label="Resources"
                isSelected={form.resources}
                onValueChange={set("resources")}
              />
              <ToggleCard
                label="Prompts"
                isSelected={form.prompts}
                onValueChange={set("prompts")}
              />
              <ToggleCard
                label="Elicitation"
                isSelected={form.elicitation}
                onValueChange={set("elicitation")}
              />
            </div>
            {fieldErrors["capabilities.tools"] && (
              <span className="text-tiny text-danger">
                {fieldErrors["capabilities.tools"]}
              </span>
            )}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Connect timeout (ms)"
                htmlFor="mcp-connect-timeout"
                hint="Budget for the initialize handshake."
                error={fieldErrors["capabilities.connectTimeoutMs"]}
              >
                <Input
                  id="mcp-connect-timeout"
                  required
                  type="number"
                  min={1}
                  max={600_000}
                  placeholder="30000"
                  value={String(form.connectTimeoutMs)}
                  onChange={(event) =>
                    setNumber("connectTimeoutMs")(event.target.value)
                  }
                  aria-invalid={Boolean(
                    fieldErrors["capabilities.connectTimeoutMs"],
                  )}
                />
              </Field>
              <Field
                label="Request timeout (ms)"
                htmlFor="mcp-request-timeout"
                hint="Budget for each request after connection."
                error={fieldErrors["capabilities.requestTimeoutMs"]}
              >
                <Input
                  id="mcp-request-timeout"
                  required
                  type="number"
                  min={1}
                  max={600_000}
                  placeholder="120000"
                  value={String(form.requestTimeoutMs)}
                  onChange={(event) =>
                    setNumber("requestTimeoutMs")(event.target.value)
                  }
                  aria-invalid={Boolean(
                    fieldErrors["capabilities.requestTimeoutMs"],
                  )}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection
            title="Availability"
            description="Whether agents may select this server, and whether the runtime connects to it without being asked."
          >
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <ToggleCard
                label="Enabled"
                hint="Available for agents to reference"
                isSelected={form.enabled}
                onValueChange={set("enabled")}
              />
              <ToggleCard
                label="Auto-connect for runs"
                hint="Connect at the start of every run"
                isSelected={form.autoConnect}
                onValueChange={set("autoConnect")}
              />
            </div>
          </FormSection>

          <FormActionBar
            cancelHref="/mcp-servers"
            saving={saving}
            dirty={dirty}
            isDisabled={saving}
            label={editing ? "Save changes" : "Create MCP server"}
          />
        </form>
      </FormBody>
    </PageShell>
  );
}

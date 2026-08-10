import { Button, Input, Select, SelectItem } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  FormActions,
  Loading,
  PageHeader,
  SectionCard,
  ToggleCard,
} from "../components/Bits.jsx";
import {
  KeyValueEditor,
  StringListEditor,
  rowsFromSecretMap,
  secretMapFromRows,
} from "../components/MapEditor.jsx";

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
      <PageHeader
        eyebrow="MCP server"
        title={editing ? `Edit ${form.name}` : "New MCP server"}
        description="Configure a stdio process or HTTP endpoint the hosted runtime can connect to."
        actions={
          <Button as={Link} to="/mcp-servers" variant="light" radius="md">
            Cancel
          </Button>
        }
      />

      <ErrorNote error={error} />

      <form className="flex max-w-[860px] flex-col gap-4" onSubmit={submit}>
        <SectionCard
          title="Identity and transport"
          description="How the runtime reaches this server."
          bodyClassName="gap-4 px-5 py-4"
        >
          <Input
            isRequired
            label="Name"
            labelPlacement="outside"
            placeholder="github-mcp"
            variant="bordered"
            maxLength={100}
            value={form.name}
            onValueChange={set("name")}
            description="Letters, digits, dot, dash, or underscore. Unique."
            isInvalid={Boolean(fieldErrors.name)}
            errorMessage={fieldErrors.name}
          />
          <Select
            label="Transport"
            labelPlacement="outside"
            placeholder="Choose a transport"
            variant="bordered"
            className="md:max-w-xs"
            selectedKeys={[form.transport]}
            onSelectionChange={(keys) =>
              changeTransport([...keys][0] ?? "http")
            }
            isInvalid={Boolean(fieldErrors.transport)}
            errorMessage={fieldErrors.transport}
          >
            <SelectItem key="stdio">stdio</SelectItem>
            <SelectItem key="http">http</SelectItem>
          </Select>

          {form.transport === "stdio" ? (
            <>
              <Input
                isRequired
                label="Command"
                labelPlacement="outside"
                placeholder="npx"
                variant="bordered"
                maxLength={1000}
                spellCheck={false}
                value={form.command}
                onValueChange={set("command")}
                description="Executable available inside the AgentCore runtime image."
                isInvalid={Boolean(fieldErrors.command)}
                errorMessage={fieldErrors.command}
              />
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
          ) : (
            <>
              <Input
                isRequired
                type="url"
                label="URL"
                labelPlacement="outside"
                placeholder="https://mcp.example.com/mcp"
                variant="bordered"
                spellCheck={false}
                value={form.url}
                onValueChange={set("url")}
                description="The HTTP MCP endpoint. HTTPS is recommended."
                isInvalid={Boolean(fieldErrors.url)}
                errorMessage={fieldErrors.url}
              />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Select
                  label="Authentication"
                  labelPlacement="outside"
                  placeholder="Choose a scheme"
                  variant="bordered"
                  selectedKeys={[form.authKind]}
                  onSelectionChange={(keys) =>
                    set("authKind")([...keys][0] ?? "bearer")
                  }
                  isInvalid={Boolean(fieldErrors["auth.kind"])}
                  errorMessage={fieldErrors["auth.kind"]}
                >
                  <SelectItem key="bearer">bearer</SelectItem>
                  <SelectItem key="header">custom header</SelectItem>
                  <SelectItem key="none">none</SelectItem>
                </Select>
                {form.authKind === "header" && (
                  <Input
                    isRequired
                    label="Authentication header"
                    labelPlacement="outside"
                    placeholder="X-API-Key"
                    variant="bordered"
                    maxLength={100}
                    value={form.headerName}
                    onValueChange={set("headerName")}
                    description="The API key is sent as this header's value."
                    isInvalid={Boolean(fieldErrors["auth.headerName"])}
                    errorMessage={fieldErrors["auth.headerName"]}
                  />
                )}
              </div>
              {form.authKind !== "none" && (
                <Input
                  type="password"
                  label="API key"
                  labelPlacement="outside"
                  placeholder={editing ? "•••••••• (unchanged)" : "Token"}
                  variant="bordered"
                  autoComplete="new-password"
                  isRequired={apiKeyRequired}
                  value={form.apiKey}
                  onValueChange={set("apiKey")}
                  description={
                    editing
                      ? "Blank leaves the stored key unchanged."
                      : "Required. The saved value is never returned to the browser."
                  }
                  isInvalid={Boolean(fieldErrors.apiKey)}
                  errorMessage={fieldErrors.apiKey}
                />
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
        </SectionCard>

        <SectionCard
          title="Capabilities and timeouts"
          description="At least one of tools, resources, or prompts must be enabled."
          bodyClassName="gap-4 px-5 py-4"
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
            <Input
              isRequired
              type="number"
              min={1}
              max={600_000}
              label="Connect timeout (ms)"
              labelPlacement="outside"
              placeholder="30000"
              variant="bordered"
              value={String(form.connectTimeoutMs)}
              onValueChange={setNumber("connectTimeoutMs")}
              description="Budget for the initialize handshake."
              isInvalid={Boolean(
                fieldErrors["capabilities.connectTimeoutMs"],
              )}
              errorMessage={fieldErrors["capabilities.connectTimeoutMs"]}
            />
            <Input
              isRequired
              type="number"
              min={1}
              max={600_000}
              label="Request timeout (ms)"
              labelPlacement="outside"
              placeholder="120000"
              variant="bordered"
              value={String(form.requestTimeoutMs)}
              onValueChange={setNumber("requestTimeoutMs")}
              description="Budget for each request after connection."
              isInvalid={Boolean(
                fieldErrors["capabilities.requestTimeoutMs"],
              )}
              errorMessage={fieldErrors["capabilities.requestTimeoutMs"]}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Availability"
          description="Whether agents may select this server."
          bodyClassName="gap-3 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ToggleCard
              label="Enabled"
              isSelected={form.enabled}
              onValueChange={set("enabled")}
            />
            <ToggleCard
              label="Auto-connect for runs"
              isSelected={form.autoConnect}
              onValueChange={set("autoConnect")}
            />
          </div>
        </SectionCard>

        <FormActions
          cancelHref="/mcp-servers"
          saving={saving}
          isDisabled={saving}
          label={editing ? "Save changes" : "Create MCP server"}
        />
      </form>
    </section>
  );
}

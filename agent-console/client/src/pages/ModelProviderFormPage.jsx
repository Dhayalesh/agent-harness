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
  rowsFromSecretMap,
  secretMapFromRows,
} from "../components/MapEditor.jsx";

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

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setNumber = (key) => (value) =>
    setForm((current) => ({
      ...current,
      [key]: value === "" ? "" : Number(value),
    }));

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
      <PageHeader
        eyebrow="Model provider"
        title={editing ? `Edit ${form.name}` : "New model provider"}
        description="Configure the endpoint, credential, and limits the hosted runtime uses for model calls."
        actions={
          <Button as={Link} to="/model-providers" variant="light" radius="md">
            Cancel
          </Button>
        }
      />

      <ErrorNote error={error} />

      <form className="flex max-w-[860px] flex-col gap-4" onSubmit={submit}>
        <SectionCard
          title="Identity and model"
          description="Which endpoint answers, and with which model."
          bodyClassName="gap-4 px-5 py-4"
        >
          <Input
            isRequired
            label="Name"
            labelPlacement="outside"
            placeholder="openrouter-sonnet"
            variant="bordered"
            maxLength={100}
            value={form.name}
            onValueChange={set("name")}
            description="Human-readable provider name. Unique."
            isInvalid={Boolean(fieldErrors.name)}
            errorMessage={fieldErrors.name}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Select
              label="Provider"
              labelPlacement="outside"
              placeholder="Choose an adapter"
              variant="bordered"
              selectedKeys={[form.provider]}
              onSelectionChange={(keys) =>
                set("provider")([...keys][0] ?? "openrouter")
              }
              isInvalid={Boolean(fieldErrors.provider)}
              errorMessage={fieldErrors.provider}
            >
              <SelectItem key="openrouter">openrouter</SelectItem>
              <SelectItem key="openai-compatible">openai-compatible</SelectItem>
            </Select>
            <Input
              isRequired
              label="Model"
              labelPlacement="outside"
              placeholder="anthropic/claude-sonnet-4.6"
              variant="bordered"
              maxLength={300}
              value={form.model}
              onValueChange={set("model")}
              isInvalid={Boolean(fieldErrors.model)}
              errorMessage={fieldErrors.model}
            />
          </div>
          <Input
            type="url"
            label="Base URL"
            labelPlacement="outside"
            placeholder="https://api.example.com/v1"
            variant="bordered"
            spellCheck={false}
            isRequired={form.provider === "openai-compatible"}
            value={form.baseURL}
            onValueChange={set("baseURL")}
            description={
              form.provider === "openrouter"
                ? "Optional. Blank uses OpenRouter's default endpoint."
                : "Required for an OpenAI-compatible provider."
            }
            isInvalid={Boolean(fieldErrors.baseURL)}
            errorMessage={fieldErrors.baseURL}
          />
        </SectionCard>

        <SectionCard
          title="Authentication"
          description="The credential is stored server-side and never returned to the browser."
          bodyClassName="gap-4 px-5 py-4"
        >
          <Input
            isReadOnly
            label="Authentication"
            labelPlacement="outside"
            variant="bordered"
            value="bearer"
            description="The hosted runtime supports Authorization: Bearer for model providers."
          />
          <Input
            type="password"
            label="API key"
            labelPlacement="outside"
            placeholder={editing ? "•••••••• (unchanged)" : "sk-…"}
            variant="bordered"
            autoComplete="new-password"
            isRequired={!editing || !form.hasApiKey}
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
          <KeyValueEditor
            label="Additional headers"
            hint="Optional static request headers. Authorization is supplied by the API key above."
            addLabel="Add header"
            keyPlaceholder="Header name"
            rows={form.headers}
            onChange={set("headers")}
            error={fieldErrors.headers}
            editing={editing}
          />
        </SectionCard>

        <SectionCard
          title="Capabilities"
          description="What the console and runtime may assume about this model."
          bodyClassName="gap-4 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              isRequired
              type="number"
              min={1}
              max={10_000_000}
              label="Context window"
              labelPlacement="outside"
              placeholder="200000"
              variant="bordered"
              value={String(form.contextWindow)}
              onValueChange={setNumber("contextWindow")}
              description="Total model context in tokens."
              isInvalid={Boolean(fieldErrors["capabilities.contextWindow"])}
              errorMessage={fieldErrors["capabilities.contextWindow"]}
            />
            <Input
              isRequired
              type="number"
              min={1}
              max={10_000_000}
              label="Max output tokens"
              labelPlacement="outside"
              placeholder="8192"
              variant="bordered"
              value={String(form.maxOutputTokens)}
              onValueChange={setNumber("maxOutputTokens")}
              description="Must be smaller than the context window."
              isInvalid={Boolean(fieldErrors["capabilities.maxOutputTokens"])}
              errorMessage={fieldErrors["capabilities.maxOutputTokens"]}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ToggleCard
              label="Supports tools"
              isSelected={form.supportsTools}
              onValueChange={set("supportsTools")}
            />
            <ToggleCard
              label="Supports streaming"
              isSelected={form.supportsStreaming}
              onValueChange={set("supportsStreaming")}
            />
            <ToggleCard
              label="Supports reasoning"
              isSelected={form.supportsReasoning}
              onValueChange={set("supportsReasoning")}
            />
            <ToggleCard
              label="Reports cost"
              isSelected={form.reportsCost}
              onValueChange={set("reportsCost")}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Availability"
          description="Whether agents may select this provider."
          bodyClassName="gap-3 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ToggleCard
              label="Enabled"
              isSelected={form.enabled}
              onValueChange={set("enabled")}
            />
            <ToggleCard
              label="Default provider"
              isSelected={form.isDefault}
              onValueChange={set("isDefault")}
            />
          </div>
        </SectionCard>

        <FormActions
          cancelHref="/model-providers"
          saving={saving}
          isDisabled={saving}
          label={editing ? "Save changes" : "Create provider"}
        />
      </form>
    </section>
  );
}

import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Chip,
  Input,
  Select,
  SelectItem,
} from "@heroui/react";
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
  pricing: null,
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
  const [catalogue, setCatalogue] = useState([]);
  const [catalogueError, setCatalogueError] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);

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
          pricing: modelProvider.pricing ?? null,
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

  const changeProvider = (keys) => {
    const provider = [...keys][0] ?? "openrouter";
    setCatalogue([]);
    setCatalogueError(null);
    setForm((current) => ({
      ...current,
      provider,
      baseURL: providerDefaultUrl(provider),
      pricing: null,
      reportsCost: provider === "openrouter",
    }));
  };

  const changeModel = (model) =>
    setForm((current) => ({
      ...current,
      model,
      pricing: current.pricing?.model === model ? current.pricing : null,
    }));

  const selectModel = (key) => {
    if (!key) return;
    const selected = catalogue.find((entry) => entry.id === key);
    if (!selected) return changeModel(String(key));
    setForm((current) => applyCatalogModel(current, selected));
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setCatalogueError(null);
    try {
      const { catalogue: found } = await api.discoverModels({
        ...(editing ? { modelProviderId: id } : {}),
        provider: form.provider,
        ...(form.baseURL.trim() ? { baseURL: form.baseURL.trim() } : {}),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      });
      setCatalogue(found.models ?? []);
      const selected = found.models?.find((entry) => entry.id === form.model);
      if (selected) {
        setForm((current) => applyCatalogModel(current, selected));
      }
    } catch (caught) {
      setCatalogueError(caught);
      setCatalogue([]);
    } finally {
      setFetchingModels(false);
    }
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
      ...(form.pricing?.model === form.model
        ? { pricing: form.pricing }
        : editing
          ? { pricing: null }
          : {}),
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
              onSelectionChange={changeProvider}
              isInvalid={Boolean(fieldErrors.provider)}
              errorMessage={fieldErrors.provider}
            >
              <SelectItem key="openrouter">openrouter</SelectItem>
              <SelectItem key="nvidia">nvidia</SelectItem>
              <SelectItem key="bedrock">bedrock</SelectItem>
              <SelectItem key="openai-compatible">openai-compatible</SelectItem>
            </Select>
            {catalogue.length ? (
              <Autocomplete
                isRequired
                allowsCustomValue
                label="Model"
                labelPlacement="outside"
                placeholder="Search fetched models"
                variant="bordered"
                items={catalogue}
                inputValue={form.model}
                selectedKey={
                  catalogue.some((entry) => entry.id === form.model)
                    ? form.model
                    : null
                }
                onInputChange={changeModel}
                onSelectionChange={selectModel}
                isInvalid={Boolean(fieldErrors.model)}
                errorMessage={fieldErrors.model}
              >
                {(model) => (
                  <AutocompleteItem key={model.id} textValue={`${model.name} ${model.id}`}>
                    <div className="flex min-w-0 flex-col py-0.5">
                      <span className="truncate text-small">{model.name}</span>
                      <span className="truncate font-mono text-tiny text-default-400">
                        {model.id}
                      </span>
                    </div>
                  </AutocompleteItem>
                )}
              </Autocomplete>
            ) : (
              <Input
                isRequired
                label="Model"
                labelPlacement="outside"
                placeholder="anthropic/claude-sonnet-4.6"
                variant="bordered"
                maxLength={300}
                value={form.model}
                onValueChange={changeModel}
                isInvalid={Boolean(fieldErrors.model)}
                errorMessage={fieldErrors.model}
              />
            )}
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
                : form.provider === "nvidia"
                  ? "NVIDIA's hosted NIM endpoint, or your OpenAI-compatible NIM URL."
                  : form.provider === "bedrock"
                    ? "Bedrock Runtime or Mantle OpenAI-compatible endpoint for its AWS region."
                    : "Required for an OpenAI-compatible provider."
            }
            isInvalid={Boolean(fieldErrors.baseURL)}
            errorMessage={fieldErrors.baseURL}
          />
          <div className="flex flex-col gap-2 rounded-medium border border-divider bg-content2/50 px-3 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-small font-medium">Automatic model catalogue</p>
              <p className="text-tiny text-default-500">
                Fetch model IDs, token limits, capabilities, and available input/output rates from the connected provider.
              </p>
            </div>
            <Button
              type="button"
              color="secondary"
              variant="flat"
              radius="md"
              isLoading={fetchingModels}
              isDisabled={fetchingModels || (!editing && !form.apiKey.trim())}
              onPress={fetchModels}
            >
              {catalogue.length ? "Refresh models" : "Fetch models & pricing"}
            </Button>
          </div>
          {catalogueError && <ErrorNote error={catalogueError} />}
          {catalogue.length > 0 && (
            <p className="text-tiny text-default-500">
              {catalogue.length.toLocaleString()} models fetched ·{" "}
              {catalogue.filter((model) => model.pricing).length.toLocaleString()} with pricing
            </p>
          )}
          <PricingSummary pricing={form.pricing} model={form.model} />
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

function PricingSummary({ pricing, model }) {
  if (!pricing || pricing.model !== model) {
    return (
      <div className="rounded-medium border border-warning-200 bg-warning-50 px-3 py-2.5 text-tiny text-warning-700 dark:border-warning-500/25 dark:bg-warning-500/10 dark:text-warning-400">
        No verified rate card is attached to this model yet. Provider-reported cost will still be stored when available; otherwise runs remain explicitly unpriced.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-medium border border-success-200 bg-success-50 px-3 py-3 dark:border-success-500/25 dark:bg-success-500/10">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-small font-semibold text-success-700 dark:text-success-400">
          Pricing synced
        </span>
        <Chip size="sm" variant="flat" color="success" className="h-5">
          USD / 1M tokens
        </Chip>
      </div>
      <p className="font-mono text-small text-foreground">
        {money(pricing.inputPerMillionTokens)} input ·{" "}
        {money(pricing.outputPerMillionTokens)} output
      </p>
      <p className="text-tiny text-default-500">
        <a
          href={pricing.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-secondary hover:underline"
        >
          {pricing.sourceLabel}
        </a>{" "}
        · fetched {new Date(pricing.fetchedAt).toLocaleString()}
      </p>
    </div>
  );
}

function applyCatalogModel(current, selected) {
  const contextWindow = selected.contextWindow ?? current.contextWindow;
  let maxOutputTokens = selected.maxOutputTokens ?? current.maxOutputTokens;
  if (maxOutputTokens >= contextWindow) {
    maxOutputTokens = Math.max(
      1,
      Math.min(current.maxOutputTokens, contextWindow - 1),
    );
  }
  return {
    ...current,
    model: selected.id,
    contextWindow,
    maxOutputTokens,
    supportsTools: selected.supportsTools ?? current.supportsTools,
    supportsStreaming:
      selected.supportsStreaming ?? current.supportsStreaming,
    supportsReasoning:
      selected.supportsReasoning ?? current.supportsReasoning,
    reportsCost: Boolean(selected.pricing),
    pricing: selected.pricing ?? null,
  };
}

function providerDefaultUrl(provider) {
  if (provider === "nvidia") return "https://integrate.api.nvidia.com/v1";
  if (provider === "bedrock") {
    return "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
  }
  return "";
}

function money(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value ?? 0);
}

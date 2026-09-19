import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ActivityIndicator,
  ErrorNote,
  Field,
  ToggleCard,
} from "../components/Bits.jsx";
import {
  FormActionBar,
  FormBody,
  FormRow,
  FormSection,
} from "../components/FormLayout.jsx";
import { Icon } from "../components/Icon.jsx";
import {
  KeyValueEditor,
  rowsFromSecretMap,
  secretMapFromRows,
} from "../components/MapEditor.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const EMPTY = {
  name: "",
  provider: "openai-compatible",
  model: "",
  baseURL: "",
  apiKey: "",
  hasApiKey: false,
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportsTools: true,
  supportsStreaming: true,
  supportsReasoning: false,
  headers: [],
  enabled: true,
  isDefault: false,
};

export function ModelProviderFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";
  const { toast } = useToast();

  const [form, setForm] = useState(editing ? null : { ...EMPTY, headers: [] });
  // Snapshot of the loaded record, so the save bar can tell whether anything
  // actually changed instead of always offering to save.
  const [baseline, setBaseline] = useState(
    editing ? null : { ...EMPTY, headers: [] },
  );
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [catalogue, setCatalogue] = useState([]);
  const [catalogueError, setCatalogueError] = useState(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [providers, setProviders] = useState([EMPTY.provider]);
  // Presentation only: the fetched-model list is a popover, so it needs to be
  // closed once a row is picked.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  useEffect(() => {
    void api
      .tools()
      .then(({ providers: found }) => {
        const configurable = found?.filter(
          (provider) => provider === EMPTY.provider,
        );
        if (configurable?.length) setProviders(configurable);
      })
      .catch(() => {
        // The provider dropdown falls back to the current value; the rest of
        // the form still works without the discovered adapter list.
      });
  }, []);

  useEffect(() => {
    if (!editing) return;
    void api
      .getModelProvider(id)
      .then(({ modelProvider }) => {
        const loaded = {
          ...EMPTY,
          ...modelProvider,
          provider: EMPTY.provider,
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
          headers: rowsFromSecretMap(
            modelProvider.headers,
            modelProvider.headerNames,
          ),
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

  // The select reports the chosen value itself, so there is no selection set to
  // unpack here any more.
  const changeProvider = (provider) => {
    setCatalogue([]);
    setCatalogueError(null);
    setForm((current) => ({ ...current, provider }));
  };

  const changeModel = (model) => setForm((current) => ({ ...current, model }));

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
      if (selected) setForm((current) => applyCatalogModel(current, selected));
      toast({
        title: `${(found.models ?? []).length.toLocaleString()} models fetched`,
        tone: "info",
      });
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
      },
      headers: secretMapFromRows(form.headers),
      enabled: form.enabled,
      isDefault: form.isDefault,
    };

    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();

    try {
      if (editing) await api.updateModelProvider(id, body);
      else
        await api.createModelProvider({ ...body, apiKey: form.apiKey.trim() });
      toast({
        title: editing ? "Provider updated" : "Provider created",
        description: body.name,
      });
      navigate("/model-providers");
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not save provider",
        description: caught.message,
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell
      breadcrumbs={[
        { label: "Configuration" },
        { label: "Model providers", to: "/model-providers" },
        { label: editing ? form.name || "Edit" : "New provider" },
      ]}
      title={editing ? `Edit ${form.name}` : "New model provider"}
      description="Configure the endpoint, credential, and limits the hosted runtime uses for model calls."
    >
      <ErrorNote error={error} />

      <FormBody>
        <form onSubmit={submit}>
          <FormSection
            title="Identity and model"
            description="Which endpoint answers, and with which model."
          >
            <Field
              label="Name"
              htmlFor="provider-name"
              hint="Human-readable provider name. Unique."
              error={fieldErrors.name}
            >
              <Input
                id="provider-name"
                required
                placeholder="openai-compatible"
                maxLength={100}
                value={form.name}
                onChange={(event) => set("name")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>
            <FormRow>
              <Field
                label="Provider"
                htmlFor="provider-adapter"
                error={fieldErrors.provider}
              >
                <Select value={form.provider} onValueChange={changeProvider}>
                  <SelectTrigger
                    id="provider-adapter"
                    aria-invalid={Boolean(fieldErrors.provider)}
                  >
                    <SelectValue placeholder="OpenAI-compatible" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {catalogue.length ? (
                <Field
                  label="Model"
                  htmlFor="provider-model"
                  error={fieldErrors.model}
                >
                  {/*
                    The fetched catalogue is a searchable list beside the field
                    rather than a menu attached to it, so a model id that is not
                    in the catalogue can still be typed straight in.
                  */}
                  <div className="flex items-center gap-2">
                    <Input
                      id="provider-model"
                      required
                      placeholder="Search fetched models"
                      value={form.model}
                      onChange={(event) => changeModel(event.target.value)}
                      aria-invalid={Boolean(fieldErrors.model)}
                    />
                    <Popover
                      open={modelPickerOpen}
                      onOpenChange={setModelPickerOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Browse fetched models"
                        >
                          <Icon name="chevron" className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-[320px] p-0">
                        <Command>
                          <CommandInput placeholder="Search fetched models" />
                          <CommandList>
                            <CommandEmpty>No matching model.</CommandEmpty>
                            <CommandGroup>
                              {catalogue.map((model) => (
                                <CommandItem
                                  key={model.id}
                                  value={`${model.name} ${model.id}`}
                                  onSelect={() => {
                                    selectModel(model.id);
                                    setModelPickerOpen(false);
                                  }}
                                >
                                  <div className="flex min-w-0 flex-col py-0.5">
                                    <span className="truncate text-small">
                                      {model.name}
                                    </span>
                                    <span className="truncate font-mono text-tiny text-default-400">
                                      {model.id}
                                    </span>
                                  </div>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                </Field>
              ) : (
                <Field
                  label="Model"
                  htmlFor="provider-model"
                  error={fieldErrors.model}
                >
                  <Input
                    id="provider-model"
                    required
                    placeholder="provider/model-id"
                    maxLength={300}
                    value={form.model}
                    onChange={(event) => changeModel(event.target.value)}
                    aria-invalid={Boolean(fieldErrors.model)}
                  />
                </Field>
              )}
            </FormRow>
            <Field
              label="Base URL"
              htmlFor="provider-base-url"
              hint="Required for an OpenAI-compatible provider."
              error={fieldErrors.baseURL}
            >
              <Input
                id="provider-base-url"
                type="url"
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                required
                value={form.baseURL}
                onChange={(event) => set("baseURL")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.baseURL)}
              />
            </Field>

            <div className="flex flex-col gap-2.5 border border-divider bg-content2 px-3.5 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-small font-medium text-foreground">
                  Automatic model catalogue
                </p>
                <p className="mt-0.5 text-tiny leading-5 text-default-500">
                  Fetch model IDs, token limits, and capabilities from the
                  connected provider.
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 shrink-0 font-medium"
                disabled={fetchingModels || (!editing && !form.apiKey.trim())}
                onClick={fetchModels}
              >
                {fetchingModels && <ActivityIndicator size="sm" />}
                {catalogue.length ? "Refresh models" : "Fetch models"}
              </Button>
            </div>
            {catalogueError && <ErrorNote error={catalogueError} />}
            {catalogue.length > 0 && (
              <p className="metric text-tiny text-default-500">
                {catalogue.length.toLocaleString()} models available
              </p>
            )}
          </FormSection>

          <FormSection
            title="Authentication"
            description="The credential is stored server-side and never returned to the browser."
          >
            <Field
              label="Scheme"
              htmlFor="provider-scheme"
              hint="The hosted runtime supports Authorization: Bearer for model providers."
            >
              <Input id="provider-scheme" readOnly value="bearer" />
            </Field>
            <Field
              label="API key"
              htmlFor="provider-api-key"
              hint={
                editing
                  ? "Blank leaves the stored key unchanged."
                  : "Required. The saved value is never returned to the browser."
              }
              error={fieldErrors.apiKey}
            >
              <Input
                id="provider-api-key"
                type="password"
                placeholder={editing ? "•••••••• (unchanged)" : "sk-…"}
                autoComplete="new-password"
                required={!editing || !form.hasApiKey}
                value={form.apiKey}
                onChange={(event) => set("apiKey")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.apiKey)}
              />
            </Field>
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
          </FormSection>

          <FormSection
            title="Capabilities"
            description="What the console and runtime may assume about this model. Fetching the catalogue fills these in."
          >
            <FormRow>
              <Field
                label="Context window"
                htmlFor="provider-context-window"
                hint="Total model context in tokens."
                error={fieldErrors["capabilities.contextWindow"]}
              >
                <Input
                  id="provider-context-window"
                  required
                  type="number"
                  min={1}
                  max={10_000_000}
                  placeholder="200000"
                  value={String(form.contextWindow)}
                  onChange={(event) =>
                    setNumber("contextWindow")(event.target.value)
                  }
                  aria-invalid={Boolean(
                    fieldErrors["capabilities.contextWindow"],
                  )}
                />
              </Field>
              <Field
                label="Max output tokens"
                htmlFor="provider-max-output-tokens"
                hint="Must be smaller than the context window."
                error={fieldErrors["capabilities.maxOutputTokens"]}
              >
                <Input
                  id="provider-max-output-tokens"
                  required
                  type="number"
                  min={1}
                  max={10_000_000}
                  placeholder="8192"
                  value={String(form.maxOutputTokens)}
                  onChange={(event) =>
                    setNumber("maxOutputTokens")(event.target.value)
                  }
                  aria-invalid={Boolean(
                    fieldErrors["capabilities.maxOutputTokens"],
                  )}
                />
              </Field>
            </FormRow>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
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
            </div>
          </FormSection>

          <FormSection
            title="Availability"
            description="Whether agents may select this provider, and whether it is offered first."
          >
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <ToggleCard
                label="Enabled"
                hint="Available for agents to reference"
                isSelected={form.enabled}
                onValueChange={set("enabled")}
              />
              <ToggleCard
                label="Default provider"
                hint="Pre-selected on new agents"
                isSelected={form.isDefault}
                onValueChange={set("isDefault")}
              />
            </div>
          </FormSection>

          <FormActionBar
            cancelHref="/model-providers"
            saving={saving}
            dirty={dirty}
            isDisabled={saving}
            label={editing ? "Save changes" : "Create provider"}
          />
        </form>
      </FormBody>
    </PageShell>
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
    supportsStreaming: selected.supportsStreaming ?? current.supportsStreaming,
    supportsReasoning: selected.supportsReasoning ?? current.supportsReasoning,
  };
}

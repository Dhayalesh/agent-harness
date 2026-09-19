import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
import { ErrorNote, Field, ToggleCard } from "../components/Bits.jsx";
import {
  FormActionBar,
  FormBody,
  FormRow,
  FormSection,
} from "../components/FormLayout.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const EMPTY = {
  name: "",
  description: "",
  systemPrompt: "",
  modelProviderId: "",
  model: "",
  tools: ["read_file", "glob", "grep"],
  skills: [],
  templates: [],
  mcpServerIds: [],
  maxTurns: 12,
  compactionThresholdPercent: "",
  maxOutputTokens: "",
  stream: false,
  enabled: true,
  isDefault: false,
};

const EMPTY_CATALOGUE = {
  tools: [],
  modelProviders: [],
  mcpServers: [],
  skills: [],
  templates: [],
};

/**
 * Adds or removes one entry from a multi-select's array, appending on select so
 * the order reflects the order things were picked in — which the template list
 * depends on, since templates are injected in selection order.
 */
const toggleValue = (values, value) =>
  values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];

/**
 * A checkbox and its label, as one row.
 *
 * The control is a native input inside a <label>: the browser supplies the keyboard
 * behaviour and reads the two as one thing, and the caller decides what the label
 * looks like — a code token, a two-line name and URI, a bare tool name.
 */
function CheckRow({
  checked,
  onChange,
  className = "",
  inputClassName = "",
  children,
}) {
  return (
    <label
      className={cn(
        "m-0 inline-flex max-w-full cursor-pointer items-center gap-2.5 rounded-lg transition-colors duration-200",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className={cn("checkbox-control shrink-0", inputClassName)}
      />
      {children}
    </label>
  );
}

/** `CheckRow` in the bordered tile the option grids are laid out from. */
function CheckTile({ checked, onChange, className = "", children }) {
  return (
    <CheckRow
      checked={checked}
      onChange={onChange}
      className={cn(
        "w-full rounded-xl border px-3 py-2.5 focus-within:border-primary/50",
        checked
          ? "border-primary/25 bg-primary/[0.05] hover:bg-primary/[0.08]"
          : "border-divider bg-content1 hover:border-primary/20 hover:bg-primary/[0.03]",
        className,
      )}
    >
      {children}
    </CheckRow>
  );
}

export function AgentFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";
  const { toast } = useToast();
  const [form, setForm] = useState(null);
  // Snapshot of the loaded record, so the save bar reports whether anything
  // actually changed rather than always offering to save.
  const [baseline, setBaseline] = useState(null);
  const [catalogue, setCatalogue] = useState(EMPTY_CATALOGUE);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [catalogueResult, agentResult] = await Promise.all([
          api.catalogue(),
          editing ? api.getAgent(id) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setCatalogue({
          tools: catalogueResult.tools ?? [],
          modelProviders: catalogueResult.modelProviders ?? [],
          mcpServers: catalogueResult.mcpServers ?? [],
          skills: catalogueResult.skills ?? [],
          templates: catalogueResult.templates ?? [],
        });

        if (agentResult) {
          const agent = agentResult.agent;
          const loaded = {
            ...EMPTY,
            ...agent,
            description: agent.description ?? "",
            model: agent.model ?? "",
            skills: (agent.skills ?? []).map((skill) => ({
              skillId: skill.skillId,
              ...(skill.allowedTools
                ? { allowedTools: [...skill.allowedTools] }
                : {}),
            })),
            templates: (agent.templates ?? []).map((template) => ({
              templateId: template.templateId,
            })),
            mcpServerIds: [...(agent.mcpServerIds ?? [])],
            maxTurns: agent.limits?.maxTurns ?? 12,
            compactionThresholdPercent:
              agent.limits?.compactionThresholdPercent ?? "",
            maxOutputTokens: agent.limits?.maxOutputTokens ?? "",
          };
          setForm(loaded);
          setBaseline(loaded);
          return;
        }

        const providers = catalogueResult.modelProviders ?? [];
        const preferred =
          providers.find(
            (provider) => provider.isDefault && provider.enabled,
          ) ??
          providers.find((provider) => provider.enabled) ??
          providers[0];
        setForm({ ...EMPTY, modelProviderId: preferred?.id ?? "" });
      } catch (caught) {
        if (!cancelled) setError(caught);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [editing, id]);

  const fieldErrors = useMemo(() => {
    const found = {};
    for (const detail of error?.details ?? [])
      found[detail.field] = detail.message;
    return found;
  }, [error]);

  // A create form is dirty from the start; there is nothing saved to match.
  const dirty = !editing || JSON.stringify(form) !== JSON.stringify(baseline);

  if (!form)
    return error ? <ErrorNote error={error} /> : <SkeletonPanels count={4} />;

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setNumber = (key) => (value) =>
    setForm((current) => ({
      ...current,
      [key]: value === "" ? "" : Number(value),
    }));

  const selectedProvider = catalogue.modelProviders.find(
    (provider) => provider.id === form.modelProviderId,
  );
  // Absent capabilities mean an older provider record, which is not the same as a
  // provider that said no, so only an explicit `false` blocks streaming.
  const streamingSupported =
    selectedProvider?.capabilities?.supportsStreaming !== false;

  const selectedSkill = (skillId) =>
    form.skills.find((entry) => entry.skillId === skillId);

  const toggleSkill = (skillId) => {
    setForm((current) => ({
      ...current,
      skills: current.skills.some((entry) => entry.skillId === skillId)
        ? current.skills.filter((entry) => entry.skillId !== skillId)
        : [...current.skills, { skillId }],
    }));
  };

  const toggleSkillTool = (skillId, tool) => {
    setForm((current) => ({
      ...current,
      skills: current.skills.map((entry) => {
        if (entry.skillId !== skillId) return entry;
        const allowed = entry.allowedTools ?? [];
        const next = allowed.includes(tool)
          ? allowed.filter((item) => item !== tool)
          : [...allowed, tool];
        return { ...entry, allowedTools: next };
      }),
    }));
  };

  const useSkillDefaults = (skillId) => {
    setForm((current) => ({
      ...current,
      skills: current.skills.map((entry) => {
        if (entry.skillId !== skillId) return entry;
        const { allowedTools: _allowedTools, ...rest } = entry;
        return rest;
      }),
    }));
  };

  // Templates are stored as records but selected as a list of ids, so the two
  // shapes are bridged here rather than at every checkbox.
  const templateIds = form.templates.map((entry) => entry.templateId);
  const setTemplateIds = (ids) =>
    setForm((current) => ({
      ...current,
      templates: ids.map((templateId) => ({ templateId })),
    }));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const limits = { maxTurns: Number(form.maxTurns) || 12 };
    if (form.compactionThresholdPercent !== "")
      limits.compactionThresholdPercent = Number(
        form.compactionThresholdPercent,
      );
    if (form.maxOutputTokens !== "")
      limits.maxOutputTokens = Number(form.maxOutputTokens);

    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      systemPrompt: form.systemPrompt,
      modelProviderId: form.modelProviderId,
      ...(form.model.trim()
        ? { model: form.model.trim() }
        : editing
          ? { model: null }
          : {}),
      tools: [...form.tools],
      skills: form.skills.map((skill) => ({
        skillId: skill.skillId,
        ...(skill.allowedTools === undefined
          ? {}
          : { allowedTools: [...skill.allowedTools] }),
      })),
      templates: form.templates.map((template) => ({
        templateId: template.templateId,
      })),
      mcpServerIds: [...form.mcpServerIds],
      limits,
      stream: form.stream,
      enabled: form.enabled,
      isDefault: form.isDefault,
    };

    try {
      const result = editing
        ? await api.updateAgent(id, body)
        : await api.createAgent(body);
      toast({
        title: editing ? "Agent updated" : "Agent created",
        description: result.agent.name,
      });
      navigate("/agents/" + result.agent.id);
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not save agent",
        description: caught.message,
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  const cancelHref = editing ? `/agents/${id}` : "/agents";

  return (
    <PageShell
      breadcrumbs={[
        { label: "Configuration" },
        { label: "Agents", to: "/agents" },
        { label: editing ? form.name || "Edit" : "New agent" },
      ]}
      title={editing ? `Edit ${form.name}` : "New agent"}
      description="Compose a model, local tools, MCP servers, skills, and templates into one runnable agent."
    >
      <ErrorNote error={error} />

      <FormBody>
        <form onSubmit={submit}>
          <FormSection
            title="Identity"
            description="How this agent is named and offered in the console."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Name"
                htmlFor="agent-name"
                hint="Letters, digits, dot, dash, and underscore."
                error={fieldErrors.name}
              >
                <Input
                  id="agent-name"
                  required
                  placeholder="research-assistant"
                  maxLength={100}
                  value={form.name}
                  onChange={(event) => set("name")(event.target.value)}
                  aria-invalid={Boolean(fieldErrors.name)}
                />
              </Field>
              <Field
                label="Description"
                htmlFor="agent-description"
                error={fieldErrors.description}
              >
                <Input
                  id="agent-description"
                  placeholder="What this agent is for"
                  maxLength={1000}
                  value={form.description}
                  onChange={(event) => set("description")(event.target.value)}
                  aria-invalid={Boolean(fieldErrors.description)}
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-3">
              <ToggleCard
                label="Enabled"
                hint="Disabled agents cannot be invoked."
                isSelected={form.enabled}
                onValueChange={set("enabled")}
              />
              <ToggleCard
                label="Default agent"
                hint="Preselected in the chat playground."
                isSelected={form.isDefault}
                onValueChange={set("isDefault")}
              />
            </div>
          </FormSection>

          <FormSection
            title="Model and instructions"
            description="The provider that answers, and the durable prompt it receives at the start of every turn."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Model provider"
                htmlFor="agent-model-provider"
                error={fieldErrors.modelProviderId}
              >
                {/*
                  A new agent starts with no provider chosen. Radix expresses "no
                  selection" as undefined — an empty string is a value that matches
                  no item, which suppresses the placeholder.
                */}
                <Select
                  required
                  value={form.modelProviderId || undefined}
                  onValueChange={set("modelProviderId")}
                >
                  <SelectTrigger
                    id="agent-model-provider"
                    aria-invalid={Boolean(fieldErrors.modelProviderId)}
                  >
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogue.modelProviders.map((provider) => (
                      <SelectItem
                        key={provider.id}
                        value={provider.id}
                        description={provider.model}
                        disabled={provider.enabled === false}
                      >
                        {provider.name}
                        {provider.enabled === false ? "(disabled)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Model override"
                htmlFor="agent-model"
                hint="Blank uses the model configured on the provider."
                error={fieldErrors.model}
              >
                <Input
                  id="agent-model"
                  placeholder="anthropic/claude-sonnet-4.6"
                  maxLength={300}
                  value={form.model}
                  onChange={(event) => set("model")(event.target.value)}
                  aria-invalid={Boolean(fieldErrors.model)}
                />
              </Field>
            </div>

            {catalogue.modelProviders.length === 0 && (
              <Alert variant="warning" className="items-center py-2">
                <span className="text-tiny">
                  Add a{" "}
                  <Link
                    to="/model-providers/new"
                    className="font-medium text-primary hover:underline"
                  >
                    model provider
                  </Link>{" "}
                  before saving this agent.
                </span>
              </Alert>
            )}

            <ToggleCard
              label="Stream responses"
              hint={
                streamingSupported
                  ? "Sent to the runtime as a preference"
                  : "This provider does not support streaming"
              }
              isSelected={form.stream}
              onValueChange={set("stream")}
              className="w-full sm:w-auto"
            />
            <p className="text-tiny text-default-500">
              Asks the runtime to answer as an event stream, which raises the
              AgentCore ceiling for one turn from 15 to 60 minutes. The chat
              page renders thinking, tool calls, and the answer as they arrive.
            </p>
            {form.stream && !streamingSupported && (
              <Alert variant="warning" className="items-center py-2">
                <span className="text-tiny">
                  {selectedProvider?.name} reports no streaming support, so this
                  agent will not pass validation until one of the two changes.
                </span>
              </Alert>
            )}

            <Field
              label="System prompt"
              htmlFor="agent-system-prompt"
              hint="The durable instructions sent on every turn."
              error={fieldErrors.systemPrompt}
            >
              <Textarea
                id="agent-system-prompt"
                required
                placeholder="You are a careful research assistant…"
                rows={10}
                value={form.systemPrompt}
                onChange={(event) => set("systemPrompt")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.systemPrompt)}
              />
            </Field>
          </FormSection>

          <FormSection
            title="Local tools"
            description="Only selected tools are offered to the model. Tools provided by MCP servers are discovered separately and do not need listing here."
          >
            <div
              role="group"
              aria-label="Local tools"
              className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
            >
              {catalogue.tools.map((tool) => (
                <CheckTile
                  key={tool.name}
                  checked={form.tools.includes(tool.name)}
                  onChange={() =>
                    set("tools")(toggleValue(form.tools, tool.name))
                  }
                >
                  <span className="flex w-full items-center gap-2">
                    <code className="border border-divider bg-content3 px-1.5 py-0.5 font-mono text-tiny text-default-600">
                      {tool.name}
                    </code>
                    {!tool.readOnly && (
                      <Badge variant="warning" className="ml-auto">
                        writes
                      </Badge>
                    )}
                  </span>
                </CheckTile>
              ))}
            </div>
          </FormSection>

          <FormSection
            title="Integrations"
            description="MCP servers the runtime connects, plus the reusable skills and prompt templates appended to this agent's instructions."
          >
            <Field
              label="MCP servers"
              hint="The runtime connects these servers for every turn."
            >
              {catalogue.mcpServers.length ? (
                <div
                  role="group"
                  aria-label="MCP servers"
                  className="mt-1 grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {catalogue.mcpServers.map((server) => (
                    <CheckTile
                      key={server.id}
                      checked={form.mcpServerIds.includes(server.id)}
                      onChange={() =>
                        set("mcpServerIds")(
                          toggleValue(form.mcpServerIds, server.id),
                        )
                      }
                    >
                      <span className="w-full min-w-0">
                        <span className="block truncate text-small font-medium">
                          {server.name}
                        </span>
                        <span className="block truncate text-tiny text-default-500">
                          {server.transport}
                        </span>
                      </span>
                    </CheckTile>
                  ))}
                </div>
              ) : (
                <p className="text-tiny text-default-500">
                  No servers configured.{" "}
                  <Link
                    to="/mcp-servers/new"
                    className="font-medium text-primary hover:underline"
                  >
                    Add one
                  </Link>
                  .
                </p>
              )}
            </Field>

            <Field
              label="Skills"
              hint="Skill documents are loaded from S3 and inlined into the run."
            >
              {catalogue.skills.length ? (
                <div className="mt-1 grid gap-2">
                  {catalogue.skills.map((skill) => {
                    const selected = selectedSkill(skill.id);
                    return (
                      <div
                        key={skill.id}
                        className={cn(
                          "rounded-xl border transition-colors duration-200 focus-within:border-primary/50",
                          selected
                            ? "border-primary/25 bg-primary/[0.05]"
                            : "border-divider bg-content1 hover:border-primary/20 hover:bg-primary/[0.03]",
                        )}
                      >
                        <CheckRow
                          checked={Boolean(selected)}
                          onChange={() => toggleSkill(skill.id)}
                          className="w-full px-3 py-2"
                        >
                          <span className="w-full min-w-0">
                            <span className="block truncate text-small font-medium">
                              {skill.name}
                            </span>
                            <span className="block truncate text-tiny text-default-500">
                              {skill.uri}
                            </span>
                          </span>
                        </CheckRow>

                        {selected && (
                          <details className="group/skill px-2 pb-1">
                            <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-tiny text-default-500 [&::-webkit-details-marker]:hidden">
                              Allowed tool override
                              <Icon
                                name="chevron"
                                className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open/skill:rotate-180"
                              />
                            </summary>
                            <div className="pb-3 pt-0">
                              <p className="mb-2 text-tiny text-default-500">
                                Leave inherited to use the skill document&apos;s
                                own allowed-tools.
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="mb-2 h-7 px-2 text-primary"
                                onClick={() => useSkillDefaults(skill.id)}
                              >
                                Use skill defaults
                              </Button>
                              <div className="flex flex-wrap gap-x-4 gap-y-2">
                                {form.tools.map((tool) => (
                                  <CheckRow
                                    key={tool}
                                    checked={
                                      selected.allowedTools?.includes(tool) ??
                                      false
                                    }
                                    onChange={() =>
                                      toggleSkillTool(skill.id, tool)
                                    }
                                    inputClassName="h-3.5 w-3.5"
                                  >
                                    <span className="font-mono text-tiny">
                                      {tool}
                                    </span>
                                  </CheckRow>
                                ))}
                              </div>
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-tiny text-default-500">
                  No skills configured.{" "}
                  <Link
                    to="/skills/new"
                    className="font-medium text-primary hover:underline"
                  >
                    Add one
                  </Link>
                  .
                </p>
              )}
            </Field>

            <Field
              label="Templates"
              hint="Template files are loaded from S3 and injected into the system prompt in selection order."
            >
              {catalogue.templates.length ? (
                <div
                  role="group"
                  aria-label="Templates"
                  className="mt-1 grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {catalogue.templates.map((template) => (
                    <CheckTile
                      key={template.id}
                      checked={templateIds.includes(template.id)}
                      onChange={() =>
                        setTemplateIds(toggleValue(templateIds, template.id))
                      }
                    >
                      <span className="w-full min-w-0">
                        <span className="block truncate text-small font-medium">
                          {template.name}
                        </span>
                        <span className="block truncate text-tiny text-default-500">
                          {ARTIFACT_FORMATS[template.format]?.label ??
                            template.format}
                          {"· "}
                          {template.uri}
                        </span>
                      </span>
                    </CheckTile>
                  ))}
                </div>
              ) : (
                <p className="text-tiny text-default-500">
                  No templates configured.{" "}
                  <Link
                    to="/templates/new"
                    className="font-medium text-primary hover:underline"
                  >
                    Add one
                  </Link>
                  .
                </p>
              )}
            </Field>
          </FormSection>

          <FormSection
            title="Limits"
            description="Ceilings applied to a single run. Leave a field blank to inherit the provider or runtime default."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field
                label="Max turns"
                htmlFor="agent-max-turns"
                error={fieldErrors["limits.maxTurns"]}
              >
                <Input
                  id="agent-max-turns"
                  required
                  type="number"
                  min={1}
                  max={1000}
                  placeholder="12"
                  value={String(form.maxTurns)}
                  onChange={(event) =>
                    setNumber("maxTurns")(event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors["limits.maxTurns"])}
                />
              </Field>
              <Field
                label="Compaction threshold (%)"
                htmlFor="agent-compaction-threshold"
                hint="Blank uses the runtime default."
                error={fieldErrors["limits.compactionThresholdPercent"]}
              >
                <Input
                  id="agent-compaction-threshold"
                  type="number"
                  min={1}
                  max={99}
                  placeholder="runtime default"
                  value={String(form.compactionThresholdPercent)}
                  onChange={(event) =>
                    setNumber("compactionThresholdPercent")(event.target.value)
                  }
                  aria-invalid={Boolean(
                    fieldErrors["limits.compactionThresholdPercent"],
                  )}
                />
              </Field>
              <Field
                label="Context window"
                htmlFor="agent-context-window"
                hint="Defined by the selected model provider."
              >
                <Input
                  id="agent-context-window"
                  type="number"
                  value={String(
                    selectedProvider?.capabilities?.contextWindow ?? "",
                  )}
                  placeholder="provider capability"
                  readOnly
                />
              </Field>
              <Field
                label="Max output tokens"
                htmlFor="agent-max-output-tokens"
                hint="Blank derives from the provider."
                error={fieldErrors["limits.maxOutputTokens"]}
              >
                <Input
                  id="agent-max-output-tokens"
                  type="number"
                  min={1}
                  max={10000000}
                  placeholder="provider default"
                  value={String(form.maxOutputTokens)}
                  onChange={(event) =>
                    setNumber("maxOutputTokens")(event.target.value)
                  }
                  aria-invalid={Boolean(fieldErrors["limits.maxOutputTokens"])}
                />
              </Field>
            </div>
          </FormSection>

          <FormActionBar
            cancelHref={cancelHref}
            saving={saving}
            dirty={dirty}
            isDisabled={saving || !form.modelProviderId}
            label={editing ? "Save changes" : "Create agent"}
          />
        </form>
      </FormBody>
    </PageShell>
  );
}

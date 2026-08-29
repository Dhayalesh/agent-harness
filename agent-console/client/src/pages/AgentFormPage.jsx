import {
  Accordion,
  AccordionItem,
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  Chip,
  Code,
  Link as HeroLink,
  Input,
  Select,
  SelectItem,
  Textarea,
} from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
import {
  ErrorNote,
  Field,
  FormActions,
  Loading,
  PageHeader,
  SectionCard,
  ToggleCard,
} from "../components/Bits.jsx";

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
  contextIntelligenceEnabled: true,
  maxRetrievalIterations: 3,
  memoryRecallLimit: 12,
  maximumExposedTools: 20,
  offloadThresholdChars: 40000,
  defaultChunkingStrategy: "recursive",
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

function agentContext(form) {
  return {
    enabled: Boolean(form.contextIntelligenceEnabled),
    budgets: {
      maxRetrievalIterations: Number(form.maxRetrievalIterations) || 3,
    },
    memory: {
      recallLimit: Number(form.memoryRecallLimit) || 12,
    },
    capability: {
      maximumExposed: Number(form.maximumExposedTools) || 20,
    },
    hygiene: {
      offloadThresholdChars: Number(form.offloadThresholdChars) || 40000,
    },
    chunking: {
      defaultStrategy: form.defaultChunkingStrategy || "recursive",
    },
  };
}

export function AgentFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";
  const [form, setForm] = useState(null);
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
          setForm({
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
            contextIntelligenceEnabled:
              agent.contextIntelligence?.enabled !== false,
            maxRetrievalIterations:
              agent.contextIntelligence?.budgets?.maxRetrievalIterations ?? 3,
            memoryRecallLimit:
              agent.contextIntelligence?.memory?.recallLimit ?? 12,
            maximumExposedTools:
              agent.contextIntelligence?.capability?.maximumExposed ?? 20,
            offloadThresholdChars:
              agent.contextIntelligence?.hygiene?.offloadThresholdChars ??
              40000,
            defaultChunkingStrategy:
              agent.contextIntelligence?.chunking?.defaultStrategy ??
              "recursive",
          });
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

  if (!form)
    return error ? <ErrorNote error={error} /> : <Loading what="agent" />;

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
      contextIntelligence: {
        ...(agentContext(form)),
      },
      stream: form.stream,
      enabled: form.enabled,
      isDefault: form.isDefault,
    };

    try {
      const result = editing
        ? await api.updateAgent(id, body)
        : await api.createAgent(body);
      navigate("/agents/" + result.agent.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  const cancelHref = editing ? `/agents/${id}` : "/agents";

  return (
    <section>
      <PageHeader
        eyebrow="Agent definition"
        title={editing ? `Edit ${form.name}` : "New agent"}
        description="Compose a model, local tools, MCP servers, skills, and templates into one runnable agent."
        actions={
          <Button as={Link} variant="light" radius="md" to={cancelHref}>
            Cancel
          </Button>
        }
      />

      <ErrorNote error={error} />

      <form className="flex max-w-[980px] flex-col gap-4" onSubmit={submit}>
        <SectionCard
          title="Identity"
          description="How this agent is named and offered in the console."
          bodyClassName="gap-4 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              isRequired
              label="Name"
              labelPlacement="outside"
              placeholder="research-assistant"
              variant="bordered"
              maxLength={100}
              value={form.name}
              onValueChange={set("name")}
              description="Letters, digits, dot, dash, and underscore."
              isInvalid={Boolean(fieldErrors.name)}
              errorMessage={fieldErrors.name}
            />
            <Input
              label="Description"
              labelPlacement="outside"
              placeholder="What this agent is for"
              variant="bordered"
              maxLength={1000}
              value={form.description}
              onValueChange={set("description")}
              isInvalid={Boolean(fieldErrors.description)}
              errorMessage={fieldErrors.description}
            />
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
        </SectionCard>

        <SectionCard
          title="Model and instructions"
          description="The provider that answers and the prompt it always receives."
          bodyClassName="gap-4 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Select
              isRequired
              label="Model provider"
              labelPlacement="outside"
              placeholder="Choose a provider"
              variant="bordered"
              selectedKeys={form.modelProviderId ? [form.modelProviderId] : []}
              disabledKeys={catalogue.modelProviders
                .filter((provider) => provider.enabled === false)
                .map((provider) => provider.id)}
              onSelectionChange={(keys) =>
                set("modelProviderId")([...keys][0] ?? "")
              }
              isInvalid={Boolean(fieldErrors.modelProviderId)}
              errorMessage={fieldErrors.modelProviderId}
            >
              {catalogue.modelProviders.map((provider) => (
                <SelectItem
                  key={provider.id}
                  textValue={`${provider.name} · ${provider.model}`}
                  description={provider.model}
                >
                  {provider.name}
                  {provider.enabled === false ? " (disabled)" : ""}
                </SelectItem>
              ))}
            </Select>
            <Input
              label="Model override"
              labelPlacement="outside"
              placeholder="anthropic/claude-sonnet-4.6"
              variant="bordered"
              maxLength={300}
              value={form.model}
              onValueChange={set("model")}
              description="Blank uses the model configured on the provider."
              isInvalid={Boolean(fieldErrors.model)}
              errorMessage={fieldErrors.model}
            />
          </div>

          {catalogue.modelProviders.length === 0 && (
            <Alert
              color="warning"
              variant="flat"
              classNames={{ base: "items-center py-2" }}
            >
              <span className="text-tiny">
                Add a{" "}
                <HeroLink href="/model-providers/new" size="sm">
                  model provider
                </HeroLink>{" "}
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
            AgentCore ceiling for one turn from 15 to 60 minutes. The chat page
            renders thinking, tool calls, and the answer as they arrive.
          </p>
          {form.stream && !streamingSupported && (
            <Alert
              color="warning"
              variant="flat"
              classNames={{ base: "items-center py-2" }}
            >
              <span className="text-tiny">
                {selectedProvider?.name} reports no streaming support, so this
                agent will not pass validation until one of the two changes.
              </span>
            </Alert>
          )}

          <Textarea
            isRequired
            label="System prompt"
            labelPlacement="outside"
            placeholder="You are a careful research assistant…"
            variant="bordered"
            minRows={10}
            maxRows={26}
            value={form.systemPrompt}
            onValueChange={set("systemPrompt")}
            description="The durable instructions sent on every turn."
            isInvalid={Boolean(fieldErrors.systemPrompt)}
            errorMessage={fieldErrors.systemPrompt}
          />
        </SectionCard>

        <SectionCard
          title="Local tools"
          description="Only selected tools are offered. MCP tools are discovered from the servers below."
          bodyClassName="gap-4 px-5 py-4"
        >
          <CheckboxGroup
            aria-label="Local tools"
            value={form.tools}
            onValueChange={set("tools")}
            classNames={{
              wrapper:
                "grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 w-full",
            }}
          >
            {catalogue.tools.map((tool) => (
              <Checkbox
                key={tool.name}
                value={tool.name}
                classNames={{
                  base: "m-0 inline-flex max-w-full w-full items-center rounded-medium border border-divider bg-content2 px-3 py-2 data-[selected=true]:border-secondary/50",
                  label: "flex w-full items-center gap-2",
                }}
              >
                <Code size="sm" className="text-tiny">
                  {tool.name}
                </Code>
                {!tool.readOnly && (
                  <Chip
                    size="sm"
                    variant="flat"
                    color="warning"
                    classNames={{
                      base: "ml-auto h-5 rounded-full",
                      content:
                        "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
                    }}
                  >
                    writes
                  </Chip>
                )}
              </Checkbox>
            ))}
          </CheckboxGroup>
        </SectionCard>

        <SectionCard
          title="Integrations"
          description="MCP servers, reusable skills, and prompt templates."
          bodyClassName="gap-6 px-5 py-4"
        >
          <Field
            label="MCP servers"
            hint="The runtime connects these servers for every turn."
          >
            {catalogue.mcpServers.length ? (
              <CheckboxGroup
                aria-label="MCP servers"
                value={form.mcpServerIds}
                onValueChange={set("mcpServerIds")}
                classNames={{
                  wrapper: "grid grid-cols-1 gap-2 sm:grid-cols-2 w-full mt-1",
                }}
              >
                {catalogue.mcpServers.map((server) => (
                  <Checkbox
                    key={server.id}
                    value={server.id}
                    classNames={{
                      base: "m-0 inline-flex max-w-full w-full items-center rounded-medium border border-divider bg-content2 px-3 py-2 data-[selected=true]:border-secondary/50",
                      label: "w-full min-w-0",
                    }}
                  >
                    <span className="block truncate text-small font-medium">
                      {server.name}
                    </span>
                    <span className="block truncate text-tiny text-default-500">
                      {server.transport}
                    </span>
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ) : (
              <p className="text-tiny text-default-500">
                No servers configured.{" "}
                <HeroLink href="/mcp-servers/new" size="sm">
                  Add one
                </HeroLink>
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
                      className={`rounded-medium border bg-content2 ${
                        selected ? "border-secondary/50" : "border-divider"
                      }`}
                    >
                      <Checkbox
                        isSelected={Boolean(selected)}
                        onValueChange={() => toggleSkill(skill.id)}
                        classNames={{
                          base: "m-0 inline-flex max-w-full w-full items-center px-3 py-2",
                          label: "w-full min-w-0",
                        }}
                      >
                        <span className="block truncate text-small font-medium">
                          {skill.name}
                        </span>
                        <span className="block truncate text-tiny text-default-500">
                          {skill.uri}
                        </span>
                      </Checkbox>

                      {selected && (
                        <Accordion
                          isCompact
                          className="px-2 pb-1"
                          itemClasses={{
                            trigger: "py-1.5",
                            title: "text-tiny text-default-500",
                            content: "pb-3 pt-0",
                          }}
                        >
                          <AccordionItem
                            key="tools"
                            aria-label="Allowed tool override"
                            title="Allowed tool override"
                          >
                            <p className="mb-2 text-tiny text-default-500">
                              Leave inherited to use the skill document&apos;s
                              own allowed-tools.
                            </p>
                            <Button
                              size="sm"
                              variant="light"
                              color="primary"
                              className="mb-2 h-7 px-2"
                              onPress={() => useSkillDefaults(skill.id)}
                            >
                              Use skill defaults
                            </Button>
                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                              {form.tools.map((tool) => (
                                <Checkbox
                                  key={tool}
                                  size="sm"
                                  isSelected={
                                    selected.allowedTools?.includes(tool) ??
                                    false
                                  }
                                  onValueChange={() =>
                                    toggleSkillTool(skill.id, tool)
                                  }
                                >
                                  <span className="font-mono text-tiny">
                                    {tool}
                                  </span>
                                </Checkbox>
                              ))}
                            </div>
                          </AccordionItem>
                        </Accordion>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-tiny text-default-500">
                No skills configured.{" "}
                <HeroLink href="/skills/new" size="sm">
                  Add one
                </HeroLink>
                .
              </p>
            )}
          </Field>

          <Field
            label="Templates"
            hint="Template files are loaded from S3 and injected into the system prompt in selection order."
          >
            {catalogue.templates.length ? (
              <CheckboxGroup
                aria-label="Templates"
                value={form.templates.map((entry) => entry.templateId)}
                onValueChange={(ids) =>
                  setForm((current) => ({
                    ...current,
                    templates: ids.map((templateId) => ({ templateId })),
                  }))
                }
                classNames={{
                  wrapper: "grid grid-cols-1 gap-2 sm:grid-cols-2 w-full mt-1",
                }}
              >
                {catalogue.templates.map((template) => (
                  <Checkbox
                    key={template.id}
                    value={template.id}
                    classNames={{
                      base: "m-0 inline-flex max-w-full w-full items-center rounded-medium border border-divider bg-content2 px-3 py-2 data-[selected=true]:border-secondary/50",
                      label: "w-full min-w-0",
                    }}
                  >
                    <span className="block truncate text-small font-medium">
                      {template.name}
                    </span>
                    <span className="block truncate text-tiny text-default-500">
                      {ARTIFACT_FORMATS[template.format]?.label ?? template.format}
                      {" · "}
                      {template.uri}
                    </span>
                  </Checkbox>
                ))}
              </CheckboxGroup>
            ) : (
              <p className="text-tiny text-default-500">
                No templates configured.{" "}
                <HeroLink href="/templates/new" size="sm">
                  Add one
                </HeroLink>
                .
              </p>
            )}
          </Field>
        </SectionCard>

        <SectionCard
          title="Context Intelligence"
          description="Curates intent, memory, evidence, observations, and relevant tools before each model decision."
          bodyClassName="gap-4 px-5 py-4"
        >
          <Checkbox
            isSelected={form.contextIntelligenceEnabled}
            onValueChange={set("contextIntelligenceEnabled")}
          >
            Enable Context Intelligence
          </Checkbox>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Input
              type="number"
              min={1}
              max={20}
              label="Retrieval iterations"
              labelPlacement="outside"
              variant="bordered"
              value={String(form.maxRetrievalIterations)}
              onValueChange={setNumber("maxRetrievalIterations")}
              description="Bounded adaptive query/retrieval retries."
            />
            <Input
              type="number"
              min={1}
              max={1000}
              label="Memory recall limit"
              labelPlacement="outside"
              variant="bordered"
              value={String(form.memoryRecallLimit)}
              onValueChange={setNumber("memoryRecallLimit")}
              description="Highest-ranked memories admitted to active context."
            />
            <Input
              type="number"
              min={1}
              max={1000}
              label="Maximum exposed tools"
              labelPlacement="outside"
              variant="bordered"
              value={String(form.maximumExposedTools)}
              onValueChange={setNumber("maximumExposedTools")}
              description="Relevant subset offered to the model."
            />
            <Input
              type="number"
              min={1000}
              max={100000000}
              label="Offload threshold (chars)"
              labelPlacement="outside"
              variant="bordered"
              value={String(form.offloadThresholdChars)}
              onValueChange={setNumber("offloadThresholdChars")}
              description="Large observations become artifact handles."
            />
            <Select
              label="Default chunking"
              labelPlacement="outside"
              variant="bordered"
              selectedKeys={[form.defaultChunkingStrategy]}
              onSelectionChange={(keys) =>
                set("defaultChunkingStrategy")([...keys][0] ?? "recursive")
              }
            >
              {[
                "fixed",
                "recursive",
                "document",
                "semantic",
                "hierarchical",
                "late",
              ].map((strategy) => (
                <SelectItem key={strategy}>{strategy}</SelectItem>
              ))}
            </Select>
          </div>
        </SectionCard>

        <SectionCard
          title="Limits"
          description="Ceilings applied to a single turn."
          bodyClassName="gap-4 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Input
              isRequired
              type="number"
              min={1}
              max={1000}
              label="Max turns"
              labelPlacement="outside"
              placeholder="12"
              variant="bordered"
              value={String(form.maxTurns)}
              onValueChange={setNumber("maxTurns")}
              isInvalid={Boolean(fieldErrors["limits.maxTurns"])}
              errorMessage={fieldErrors["limits.maxTurns"]}
            />
            <Input
              type="number"
              label="Context window"
              labelPlacement="outside"
              variant="bordered"
              value={String(
                selectedProvider?.capabilities?.contextWindow ?? "",
              )}
              placeholder="provider capability"
              description="Defined by the selected model provider."
              isReadOnly
            />
            <Input
              type="number"
              min={1}
              max={10000000}
              label="Max output tokens"
              labelPlacement="outside"
              placeholder="provider default"
              variant="bordered"
              value={String(form.maxOutputTokens)}
              onValueChange={setNumber("maxOutputTokens")}
              description="Blank derives from the provider."
              isInvalid={Boolean(fieldErrors["limits.maxOutputTokens"])}
              errorMessage={fieldErrors["limits.maxOutputTokens"]}
            />
          </div>
        </SectionCard>

        <FormActions
          cancelHref={cancelHref}
          saving={saving}
          isDisabled={saving || !form.modelProviderId}
          label={editing ? "Save changes" : "Create agent"}
        />
      </form>
    </section>
  );
}

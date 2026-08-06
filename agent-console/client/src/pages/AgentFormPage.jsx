import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, Loading } from "../components/Bits.jsx";

const EMPTY = {
  name: "",
  description: "",
  systemPrompt: "",
  modelProviderId: "",
  model: "",
  tools: ["read_file", "glob", "grep"],
  skills: [],
  mcpServerIds: [],
  maxTurns: 12,
  maxInputTokens: "",
  maxOutputTokens: "",
  enabled: true,
  isDefault: false,
};

const EMPTY_CATALOGUE = {
  tools: [],
  modelProviders: [],
  mcpServers: [],
  skills: [],
};

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
            mcpServerIds: [...(agent.mcpServerIds ?? [])],
            maxTurns: agent.limits?.maxTurns ?? 12,
            maxInputTokens: agent.limits?.maxInputTokens ?? "",
            maxOutputTokens: agent.limits?.maxOutputTokens ?? "",
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

  const toggleListValue = (key, value) => {
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

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
    if (form.maxInputTokens !== "")
      limits.maxInputTokens = Number(form.maxInputTokens);
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
      mcpServerIds: [...form.mcpServerIds],
      limits,
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

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="eyebrow">Agent definition</span>
          <h1>{editing ? "Edit " + form.name : "New agent"}</h1>
          <p className="muted">
            Compose a model, local tools, MCP servers, and skills into one
            runnable agent.
          </p>
        </div>
        <Link to={editing ? "/agents/" + id : "/agents"}>Cancel</Link>
      </div>

      <ErrorNote error={error} />

      <form className="form form-wide" onSubmit={submit}>
        <fieldset>
          <legend>Identity</legend>
          <div className="row">
            <Field
              label="Name"
              hint="Letters, digits, dot, dash, and underscore."
              error={fieldErrors.name}
            >
              <input
                value={form.name}
                onChange={set("name")}
                required
                maxLength={100}
              />
            </Field>
            <Field label="Description" error={fieldErrors.description}>
              <input
                value={form.description}
                onChange={set("description")}
                maxLength={1000}
              />
            </Field>
          </div>
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
              Default agent
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Model and instructions</legend>
          <div className="row">
            <Field label="Model provider" error={fieldErrors.modelProviderId}>
              <select
                value={form.modelProviderId}
                onChange={set("modelProviderId")}
                required
              >
                <option value="">Choose a provider</option>
                {catalogue.modelProviders.map((provider) => (
                  <option
                    key={provider.id}
                    value={provider.id}
                    disabled={provider.enabled === false}
                  >
                    {provider.name} · {provider.model}
                    {provider.enabled === false ? " (disabled)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Model override"
              hint="Blank uses the model configured on the provider."
              error={fieldErrors.model}
            >
              <input
                value={form.model}
                onChange={set("model")}
                maxLength={300}
              />
            </Field>
          </div>
          {catalogue.modelProviders.length === 0 && (
            <p className="warn">
              Add a <Link to="/model-providers/new">model provider</Link> before
              saving this agent.
            </p>
          )}
          <Field
            label="System prompt"
            hint="The durable instructions sent on every turn."
            error={fieldErrors.systemPrompt}
          >
            <textarea
              value={form.systemPrompt}
              onChange={set("systemPrompt")}
              rows={10}
              required
            />
          </Field>
        </fieldset>

        <fieldset>
          <legend>Local tools</legend>
          <p className="field-hint">
            Only selected tools are offered. MCP tools are discovered from the
            servers below.
          </p>
          <div className="checks">
            {catalogue.tools.map((tool) => (
              <label className="check" key={tool.name}>
                <input
                  type="checkbox"
                  checked={form.tools.includes(tool.name)}
                  onChange={() => toggleListValue("tools", tool.name)}
                />
                <code>{tool.name}</code>
                {!tool.readOnly && <span className="tag-write">writes</span>}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Integrations</legend>
          <div className="integration-section">
            <div className="section-copy">
              <strong>MCP servers</strong>
              <span className="field-hint">
                The runtime connects these servers for every turn.
              </span>
            </div>
            {catalogue.mcpServers.length ? (
              <div className="checks">
                {catalogue.mcpServers.map((server) => (
                  <label className="check" key={server.id}>
                    <input
                      type="checkbox"
                      checked={form.mcpServerIds.includes(server.id)}
                      onChange={() =>
                        toggleListValue("mcpServerIds", server.id)
                      }
                    />
                    <span>
                      <strong>{server.name}</strong>
                      <small>{server.transport}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="field-hint">
                No servers configured.{" "}
                <Link to="/mcp-servers/new">Add one</Link>.
              </p>
            )}
          </div>

          <div className="integration-section">
            <div className="section-copy">
              <strong>Skills</strong>
              <span className="field-hint">
                Skill documents are loaded from S3 and inlined into the run.
              </span>
            </div>
            {catalogue.skills.length ? (
              <div className="skill-picker">
                {catalogue.skills.map((skill) => {
                  const selected = selectedSkill(skill.id);
                  return (
                    <div
                      className={
                        selected
                          ? "skill-option skill-option-selected"
                          : "skill-option"
                      }
                      key={skill.id}
                    >
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={Boolean(selected)}
                          onChange={() => toggleSkill(skill.id)}
                        />
                        <span>
                          <strong>{skill.name}</strong>
                          <small>{skill.uri}</small>
                        </span>
                      </label>
                      {selected && (
                        <details>
                          <summary>Allowed tool override</summary>
                          <p className="field-hint">
                            Leave inherited to use the skill document&apos;s own
                            allowed-tools.
                          </p>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => useSkillDefaults(skill.id)}
                          >
                            Use skill defaults
                          </button>
                          <div className="mini-checks">
                            {form.tools.map((tool) => (
                              <label key={tool}>
                                <input
                                  type="checkbox"
                                  checked={
                                    selected.allowedTools?.includes(tool) ??
                                    false
                                  }
                                  onChange={() =>
                                    toggleSkillTool(skill.id, tool)
                                  }
                                />
                                <code>{tool}</code>
                              </label>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="field-hint">
                No skills configured. <Link to="/skills/new">Add one</Link>.
              </p>
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend>Limits</legend>
          <div className="row three-column">
            <Field label="Max turns" error={fieldErrors["limits.maxTurns"]}>
              <input
                type="number"
                min={1}
                max={1000}
                value={form.maxTurns}
                onChange={set("maxTurns")}
                required
              />
            </Field>
            <Field
              label="Max input tokens"
              hint="Blank derives from the provider."
              error={fieldErrors["limits.maxInputTokens"]}
            >
              <input
                type="number"
                min={1}
                max={10000000}
                value={form.maxInputTokens}
                onChange={set("maxInputTokens")}
              />
            </Field>
            <Field
              label="Max output tokens"
              hint="Blank derives from the provider."
              error={fieldErrors["limits.maxOutputTokens"]}
            >
              <input
                type="number"
                min={1}
                max={10000000}
                value={form.maxOutputTokens}
                onChange={set("maxOutputTokens")}
              />
            </Field>
          </div>
        </fieldset>

        <div className="form-actions">
          <button
            type="submit"
            className="primary"
            disabled={saving || !form.modelProviderId}
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Create agent"}
          </button>
          <Link to={editing ? "/agents/" + id : "/agents"}>Cancel</Link>
        </div>
      </form>
    </section>
  );
}

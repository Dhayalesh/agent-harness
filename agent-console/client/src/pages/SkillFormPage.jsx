import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, ToggleCard } from "../components/Bits.jsx";
import {
  FormActionBar,
  FormBody,
  FormSection,
} from "../components/FormLayout.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const EMPTY = {
  name: "",
  routingDescription: "",
  content: "",
  enabled: true,
};

export function SkillFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";
  const { toast } = useToast();

  const [form, setForm] = useState(editing ? null : { ...EMPTY });
  const [baseline, setBaseline] = useState(editing ? null : { ...EMPTY });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getSkill(id)
      .then(({ skill }) => {
        const loaded = { ...EMPTY, ...skill };
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

  const dirty = useMemo(
    () => !editing || JSON.stringify(form) !== JSON.stringify(baseline),
    [editing, form, baseline],
  );

  if (form === null)
    return error ? <ErrorNote error={error} /> : <SkeletonPanels count={2} />;

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const body = {
      name: form.name.trim(),
      routingDescription: form.routingDescription.trim(),
      content: form.content,
      enabled: form.enabled,
    };

    try {
      if (editing) await api.updateSkill(id, body);
      else await api.createSkill(body);
      toast({
        title: editing ? "Skill updated" : "Skill created",
        description: body.name,
      });
      navigate("/skills");
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not save skill",
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
        { label: "Skills", to: "/skills" },
        { label: editing ? form.name || "Edit" : "New skill" },
      ]}
      title={editing ? `Edit ${form.name}` : "New skill"}
      description="Author skill instructions as plain text or Markdown. The console saves both as a Markdown file in S3."
    >
      <ErrorNote error={error} />

      <FormBody>
        <form onSubmit={submit}>
          <FormSection
            title="Identity"
            description="The name an agent references this skill by. It becomes the stored filename, which is why dots are not allowed."
          >
            <Field
              label="Name"
              htmlFor="skill-name"
              hint="Letters, digits, dash, or underscore. Unique."
              error={fieldErrors.name}
            >
              <Input
                id="skill-name"
                required
                placeholder="research"
                maxLength={100}
                pattern="[A-Za-z0-9_-]+"
                value={form.name}
                onChange={(event) => set("name")(event.target.value)}
                aria-invalid={Boolean(fieldErrors.name)}
              />
            </Field>
            <Field
              label="When to use this skill"
              htmlFor="skill-routing-description"
              hint="Required when automatic skill selection is enabled. Describe the tasks this skill handles."
              error={fieldErrors.routingDescription}
            >
              <Textarea
                id="skill-routing-description"
                maxLength={400}
                value={form.routingDescription}
                onChange={(event) =>
                  set("routingDescription")(event.target.value)
                }
              />
            </Field>
            <ToggleCard
              label="Enabled"
              hint="Disabled skills are not offered to agents"
              isSelected={form.enabled}
              onValueChange={set("enabled")}
            />
          </FormSection>

          <FormSection
            title="Instructions"
            description="Loaded by the agent when it runs. Written as a UTF-8 .md document, so Markdown headings and lists are preserved."
          >
            <Field
              label="Skill content"
              htmlFor="skill-content"
              error={fieldErrors.content}
            >
              <Textarea
                id="skill-content"
                required
                placeholder={
                  "# Research skill\n\nUse trusted sources and cite every finding."
                }
                rows={16}
                maxLength={2_000_000}
                spellCheck={false}
                value={form.content}
                onChange={(event) => set("content")(event.target.value)}
                className="font-mono text-tiny leading-6"
                aria-invalid={Boolean(fieldErrors.content)}
              />
            </Field>
            <p className="metric text-tiny text-default-500">
              {form.content.length.toLocaleString()} characters
            </p>
          </FormSection>

          <FormActionBar
            cancelHref="/skills"
            saving={saving}
            dirty={dirty}
            isDisabled={saving}
            label={editing ? "Save changes" : "Create skill"}
          />
        </form>
      </FormBody>
    </PageShell>
  );
}

import { Button, Input } from "@heroui/react";
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

const EMPTY = {
  name: "",
  uri: "",
  enabled: true,
};

export function SkillFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";

  const [form, setForm] = useState(editing ? null : { ...EMPTY });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getSkill(id)
      .then(({ skill }) => setForm({ ...EMPTY, ...skill }))
      .catch(setError);
  }, [editing, id]);

  const fieldErrors = useMemo(() => {
    const map = {};
    for (const detail of error?.details ?? []) map[detail.field] = detail.message;
    return map;
  }, [error]);

  if (form === null)
    return error ? <ErrorNote error={error} /> : <Loading what="skill" />;

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const body = {
      name: form.name.trim(),
      uri: form.uri.trim(),
      enabled: form.enabled,
    };

    try {
      if (editing) await api.updateSkill(id, body);
      else await api.createSkill(body);
      navigate("/skills");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Skill"
        title={editing ? `Edit ${form.name}` : "New skill"}
        description="Point to a SKILL.md document the console can load into an AgentCore invocation."
        actions={
          <Button as={Link} to="/skills" variant="light" radius="md">
            Cancel
          </Button>
        }
      />

      <ErrorNote error={error} />

      <form className="flex max-w-[860px] flex-col gap-4" onSubmit={submit}>
        <SectionCard
          title="Skill"
          description="The document is read when the agent runs, not when it is saved."
          bodyClassName="gap-4 px-5 py-4"
        >
          <Input
            isRequired
            label="Name"
            labelPlacement="outside"
            placeholder="research"
            variant="bordered"
            maxLength={100}
            pattern="[A-Za-z0-9_-]+"
            value={form.name}
            onValueChange={set("name")}
            description="Letters, digits, dash, or underscore. Unique; dots are not allowed."
            isInvalid={Boolean(fieldErrors.name)}
            errorMessage={fieldErrors.name}
          />
          <Input
            isRequired
            label="SKILL.md URI"
            labelPlacement="outside"
            placeholder="s3://my-agent-assets/skills/research/SKILL.md"
            variant="bordered"
            maxLength={2048}
            pattern="(?:s3://|https://).+"
            spellCheck={false}
            value={form.uri}
            onValueChange={set("uri")}
            description="An s3:// URI or an HTTPS URL that points directly to AWS S3."
            isInvalid={Boolean(fieldErrors.uri)}
            errorMessage={fieldErrors.uri}
          />
          <ToggleCard
            label="Enabled"
            hint="Disabled skills are not offered to agents."
            isSelected={form.enabled}
            onValueChange={set("enabled")}
            className="sm:max-w-sm"
          />
        </SectionCard>

        <FormActions
          cancelHref="/skills"
          saving={saving}
          isDisabled={saving}
          label={editing ? "Save changes" : "Create skill"}
        />
      </form>
    </section>
  );
}

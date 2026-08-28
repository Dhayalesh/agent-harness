import { Button, Input, Select, SelectItem, Textarea } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
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
  content: "",
  format: "markdown",
  enabled: true,
};

const FORMAT_OPTIONS = Object.entries(ARTIFACT_FORMATS);

export function TemplateFormPage({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = mode === "edit";
  const [form, setForm] = useState(editing ? null : { ...EMPTY });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    void api
      .getTemplate(id)
      .then(({ template }) => setForm({ ...EMPTY, ...template }))
      .catch(setError);
  }, [editing, id]);

  const fieldErrors = useMemo(() => {
    const map = {};
    for (const detail of error?.details ?? []) map[detail.field] = detail.message;
    return map;
  }, [error]);

  if (form === null)
    return error ? <ErrorNote error={error} /> : <Loading what="template" />;

  const set = (key) => (value) =>
    setForm((current) => ({ ...current, [key]: value }));
  const chooseFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const content = await file.text();
      const inferredName = file.name.replace(/\.[^.]+$/, "");
      setForm((current) => ({
        ...current,
        content,
        name: current.name || inferredName,
      }));
    } catch {
      setError(new Error("Unable to read the selected file as UTF-8 text."));
    } finally {
      event.target.value = "";
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      content: form.content,
      format: form.format,
      enabled: form.enabled,
    };

    try {
      if (editing) await api.updateTemplate(id, body);
      else await api.createTemplate(body);
      navigate("/templates");
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Template"
        title={editing ? `Edit ${form.name}` : "New template"}
        description="Upload a text or Markdown file, or author its content here. The document is stored in S3 and injected into assigned agents."
        actions={
          <Button as={Link} to="/templates" variant="light" radius="md">
            Cancel
          </Button>
        }
      />

      <ErrorNote error={error} />

      <form className="flex max-w-[860px] flex-col gap-4" onSubmit={submit}>
        <SectionCard
          title="Template"
          description="Assigned templates are loaded from S3 and appended to the agent system prompt in selection order."
          bodyClassName="gap-4 px-5 py-4"
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              isRequired
              label="Name"
              labelPlacement="outside-top"
              placeholder="customer-response"
              variant="bordered"
              maxLength={100}
              pattern="[A-Za-z0-9_-]+"
              value={form.name}
              onValueChange={set("name")}
              description="Letters, digits, dash, or underscore. Unique; dots are not allowed."
              isInvalid={Boolean(fieldErrors.name)}
              errorMessage={fieldErrors.name}
            />
            <div className="flex min-w-0 flex-col">
              <span
                aria-hidden="true"
                className={`pb-2 text-small ${
                  fieldErrors.format ? "text-danger" : "text-foreground"
                }`}
              >
                Generated file format
                <span className="ms-0.5 text-danger">*</span>
              </span>
              <Select
                isRequired
                label="Generated file format"
                labelPlacement="outside-top"
                placeholder="Choose a format"
                variant="bordered"
                classNames={{ label: "sr-only" }}
                selectedKeys={form.format ? [form.format] : []}
                onSelectionChange={(keys) => set("format")([...keys][0] ?? "")}
                description="The artifact format used when this template produces a file."
                isInvalid={Boolean(fieldErrors.format)}
                errorMessage={fieldErrors.format}
              >
                {FORMAT_OPTIONS.map(([value, format]) => (
                  <SelectItem key={value} textValue={format.label}>
                    {format.label} ({format.extension})
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
          <Input
            type="file"
            accept=".md,.txt,text/markdown,text/plain"
            label="Upload file"
            labelPlacement="outside"
            variant="bordered"
            description="Select one UTF-8 .md or .txt file. You can review or edit it below before saving."
            onChange={chooseFile}
          />
          <Textarea
            isRequired
            label="Template content"
            labelPlacement="outside"
            placeholder="# Response template\n\nFollow this structure when answering..."
            variant="bordered"
            minRows={12}
            maxRows={28}
            maxLength={500_000}
            spellCheck={false}
            value={form.content}
            onValueChange={set("content")}
            description="UTF-8 plain text or Markdown, up to 500,000 characters."
            isInvalid={Boolean(fieldErrors.content)}
            errorMessage={fieldErrors.content}
          />
          <ToggleCard
            label="Enabled"
            hint="Disabled templates cannot be assigned to agents."
            isSelected={form.enabled}
            onValueChange={set("enabled")}
            className="sm:max-w-sm"
          />
        </SectionCard>

        <FormActions
          cancelHref="/templates"
          saving={saving}
          isDisabled={saving}
          label={editing ? "Save changes" : "Create template"}
        />
      </form>
    </section>
  );
}

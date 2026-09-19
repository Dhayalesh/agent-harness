import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
import { ErrorNote, Field, ToggleCard } from "../components/Bits.jsx";
import {
  FormActionBar,
  FormBody,
  FormRow,
  FormSection,
} from "../components/FormLayout.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
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
  content: "",
  format: "markdown",
  enabled: true,
};

const FORMAT_OPTIONS = Object.entries(ARTIFACT_FORMATS);

export function TemplateFormPage({ mode }) {
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
      .getTemplate(id)
      .then(({ template }) => {
        const loaded = { ...EMPTY, ...template };
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
      toast({ title: "File loaded", description: file.name, tone: "info" });
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
      toast({
        title: editing ? "Template updated" : "Template created",
        description: body.name,
      });
      navigate("/templates");
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not save template",
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
        { label: "Templates", to: "/templates" },
        { label: editing ? form.name || "Edit" : "New template" },
      ]}
      title={editing ? `Edit ${form.name}` : "New template"}
      description="Upload a text or Markdown file, or author its content here. The document is stored in S3 and injected into assigned agents."
    >
      <ErrorNote error={error} />

      <FormBody>
        <form onSubmit={submit}>
          <FormSection
            title="Identity"
            description="Assigned templates are appended to the agent system prompt in selection order."
          >
            <FormRow>
              <Field
                label="Name"
                htmlFor="template-name"
                hint="Letters, digits, dash, or underscore. Unique."
                error={fieldErrors.name}
              >
                <Input
                  id="template-name"
                  required
                  placeholder="customer-response"
                  maxLength={100}
                  pattern="[A-Za-z0-9_-]+"
                  value={form.name}
                  onChange={(event) => set("name")(event.target.value)}
                  aria-invalid={Boolean(fieldErrors.name)}
                />
              </Field>
              <Field
                label="Generated file format"
                htmlFor="template-format"
                hint="Used when this template produces a file."
                error={fieldErrors.format}
              >
                <Select
                  required
                  value={form.format}
                  onValueChange={set("format")}
                >
                  <SelectTrigger
                    id="template-format"
                    aria-invalid={Boolean(fieldErrors.format)}
                  >
                    <SelectValue placeholder="Choose a format" />
                  </SelectTrigger>
                  <SelectContent>
                    {FORMAT_OPTIONS.map(([value, format]) => (
                      <SelectItem key={value} value={value}>
                        {format.label} ({format.extension})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FormRow>
            <ToggleCard
              label="Enabled"
              hint="Disabled templates cannot be assigned to agents"
              isSelected={form.enabled}
              onValueChange={set("enabled")}
            />
          </FormSection>

          <FormSection
            title="Content"
            description="Upload a UTF-8 .md or .txt file to populate the editor, or write it directly. Either way you can review it before saving."
          >
            <Field
              label="Upload file"
              htmlFor="template-upload"
              hint="Optional. Replaces the content below."
            >
              <Input
                id="template-upload"
                type="file"
                accept=".md,.txt,text/markdown,text/plain"
                onChange={chooseFile}
              />
            </Field>
            <Field
              label="Template content"
              htmlFor="template-content"
              error={fieldErrors.content}
            >
              <Textarea
                id="template-content"
                required
                placeholder={
                  "# Response template\n\nFollow this structure when answering..."
                }
                rows={16}
                maxLength={500_000}
                spellCheck={false}
                value={form.content}
                onChange={(event) => set("content")(event.target.value)}
                className="font-mono text-tiny leading-6"
                aria-invalid={Boolean(fieldErrors.content)}
              />
            </Field>
            <p className="metric text-tiny text-default-500">
              {form.content.length.toLocaleString()} of 500,000 characters
            </p>
          </FormSection>

          <FormActionBar
            cancelHref="/templates"
            saving={saving}
            dirty={dirty}
            isDisabled={saving}
            label={editing ? "Save changes" : "Create template"}
          />
        </form>
      </FormBody>
    </PageShell>
  );
}

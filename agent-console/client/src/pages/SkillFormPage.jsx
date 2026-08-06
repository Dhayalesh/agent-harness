import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ErrorNote, Field, Loading } from "../components/Bits.jsx";

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

  const set = (key) => (event) => {
    const value =
      event.target.type === "checkbox"
        ? event.target.checked
        : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

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
      <div className="page-head">
        <div>
          <h1>{editing ? `Edit ${form.name}` : "New skill"}</h1>
          <p className="muted">
            Point to a SKILL.md document the console can load into an AgentCore
            invocation.
          </p>
        </div>
        <Link to="/skills">Cancel</Link>
      </div>

      <ErrorNote error={error} />

      <form className="form" onSubmit={submit}>
        <fieldset>
          <legend>Skill</legend>
          <Field
            label="Name"
            hint="Letters, digits, dash, or underscore. Unique; dots are not allowed."
            error={fieldErrors.name}
          >
            <input
              value={form.name}
              onChange={set("name")}
              required
              maxLength={100}
              pattern="[A-Za-z0-9_-]+"
            />
          </Field>
          <Field
            label="SKILL.md URI"
            hint="An s3:// URI or an HTTPS URL that points directly to AWS S3. The document is read when the agent runs."
            error={fieldErrors.uri}
          >
            <input
              value={form.uri}
              onChange={set("uri")}
              required
              maxLength={2048}
              pattern="(?:s3://|https://).+"
              placeholder="s3://my-agent-assets/skills/research/SKILL.md"
              spellCheck={false}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={set("enabled")}
            />
            Enabled
          </label>
        </fieldset>

        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving
              ? "Saving..."
              : editing
                ? "Save changes"
                : "Create skill"}
          </button>
          <Link to="/skills">Cancel</Link>
        </div>
      </form>
    </section>
  );
}

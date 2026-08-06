import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  when,
} from "../components/Bits.jsx";

export function SkillsPage() {
  const [skills, setSkills] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const { skills: found } = await api.listSkills({ q });
      setSkills(found);
    } catch (caught) {
      setError(caught);
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const visibleSkills = useMemo(() => {
    if (!skills || !query.trim()) return skills;
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) =>
      [skill.name, skill.uri]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [skills, query]);

  const remove = async (skill) => {
    const confirmed = window.confirm(
      `Delete skill "${skill.name}"? Agents that reference it must be updated first.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteSkill(skill.id);
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Skills</h1>
          <p className="muted">
            Reusable SKILL.md instructions loaded from S3 or HTTPS for an agent
            run.
          </p>
        </div>
        <div className="resource-toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search skills"
          />
          <Link to="/skills/new">New skill</Link>
        </div>
      </div>

      <ErrorNote error={error} />

      {skills === null ? (
        <Loading what="skills" />
      ) : visibleSkills.length === 0 ? (
        <p className="empty">
          {query ? "No skills match this search." : "No skills found."}{" "}
          {!query && <Link to="/skills/new">Create one</Link>}
          {!query && "."}
        </p>
      ) : (
        <ul className="resource-list">
          {visibleSkills.map((skill) => (
            <li key={skill.id} className="resource-row">
              <div className="resource-summary">
                <div className="resource-title-row">
                  <strong>{skill.name}</strong>
                  <span className="resource-badges">
                    <span className="pill">
                      {skill.uri?.startsWith("s3://") ? "S3" : "HTTPS"}
                    </span>
                    <StatusPill
                      status={skill.enabled ? "enabled" : "disabled"}
                    />
                  </span>
                </div>
                <p className="muted resource-uri">
                  <code>{skill.uri}</code>
                </p>
                <dl className="meta">
                  <div>
                    <dt>Updated</dt>
                    <dd>{when(skill.updatedAt)}</dd>
                  </div>
                </dl>
              </div>
              <div className="card-actions">
                <Link to={`/skills/${skill.id}/edit`}>Edit</Link>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove(skill)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

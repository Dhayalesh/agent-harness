import { Button, Chip, Code } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  EmptyState,
  ErrorNote,
  Loading,
  PageHeader,
  SearchInput,
  StatusPill,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";
import { ResourceRow } from "../components/ResourceRow.jsx";

export function SkillsPage() {
  const [skills, setSkills] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

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
    const confirmed = await confirm({
      title: "Delete skill",
      body: `Delete skill "${skill.name}"? Agents that reference it must be updated first.`,
      confirmLabel: "Delete skill",
    });
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
      <PageHeader
        eyebrow="Build"
        title="Skills"
        description="Reusable SKILL.md instructions loaded from S3 or HTTPS for an agent run."
        actions={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              label="Search skills"
              placeholder="Search skills"
            />
            <Button
              as={Link}
              to="/skills/new"
              color="primary"
              radius="md"
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New skill
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {skills === null ? (
        <Loading what="skills" />
      ) : visibleSkills.length === 0 ? (
        <EmptyState
          icon="skills"
          title={query ? "No skills match this search." : "No skills found."}
          description={
            query
              ? "Try a different search."
              : "Point at a SKILL.md document an agent can load at run time."
          }
          action={
            !query && (
              <Button as={Link} to="/skills/new" color="primary" radius="md">
                Create one
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {visibleSkills.map((skill) => (
            <li key={skill.id}>
              <ResourceRow
                title={skill.name}
                editHref={`/skills/${skill.id}/edit`}
                deleteLabel={`Delete ${skill.name}`}
                onDelete={() => remove(skill)}
                badges={
                  <>
                    <Chip
                      size="sm"
                      variant="flat"
                      color="primary"
                      classNames={{
                        base: "h-5 rounded-full",
                        content:
                          "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
                      }}
                    >
                      {skill.uri?.startsWith("s3://") ? "S3" : "HTTPS"}
                    </Chip>
                    <StatusPill status={skill.enabled ? "enabled" : "disabled"} />
                  </>
                }
                summary={
                  <Code size="sm" className="max-w-full truncate text-tiny">
                    {skill.uri}
                  </Code>
                }
                meta={[{ label: "Updated", value: when(skill.updatedAt) }]}
              />
            </li>
          ))}
        </ul>
      )}

      {confirmDialog}
    </section>
  );
}

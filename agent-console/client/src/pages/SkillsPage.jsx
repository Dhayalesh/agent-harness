import { useCallback, useMemo } from "react";
import { api } from "../api.js";
import { MonoValue, StatusPill, Tag } from "../components/Bits.jsx";
import { ResourceListPage, updatedColumn } from "./ResourceListPage.jsx";

const storageOf = (row) => (row.uri?.startsWith("s3://") ? "S3" : "HTTPS");

export function SkillsPage() {
  const load = useCallback(
    async (q) => (await api.listSkills({ q })).skills,
    [],
  );
  const remove = useCallback((row) => api.deleteSkill(row.id), []);
  const search = useCallback((row) => [row.name, row.uri], []);

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Skill",
        primary: true,
        sortable: true,
        width: "30%",
        value: (row) => row.name,
      },
      {
        key: "storage",
        header: "Storage",
        sortable: true,
        width: "104px",
        value: storageOf,
        render: (row) => <Tag tone="brand">{storageOf(row)}</Tag>,
      },
      {
        key: "uri",
        header: "Location",
        width: "auto",
        hideBelow: "md",
        value: (row) => row.uri,
        render: (row) => (
          <MonoValue className="line-clamp-1">{row.uri || "—"}</MonoValue>
        ),
      },
      {
        key: "state",
        header: "State",
        width: "120px",
        value: (row) => (row.enabled ? "enabled" : "disabled"),
        render: (row) => (
          <StatusPill status={row.enabled ? "enabled" : "disabled"} />
        ),
      },
      updatedColumn(),
    ],
    [],
  );

  return (
    <ResourceListPage
      breadcrumbs={[{ label: "Configuration" }, { label: "Skills" }]}
      title="Skills"
      description="Reusable skill instructions authored here and saved as Markdown in S3."
      newHref="/skills/new"
      newLabel="New skill"
      singular="skill"
      plural="skills"
      emptyIcon="skills"
      emptyDescription="Create reusable instructions as plain text or Markdown."
      searchPlaceholder="Search name or location"
      editHref={(row) => `/skills/${row.id}/edit`}
      columns={columns}
      load={load}
      remove={remove}
      search={search}
    />
  );
}

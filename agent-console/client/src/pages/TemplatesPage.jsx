import { useCallback, useMemo } from "react";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
import { MonoValue, StatusPill, Tag } from "../components/Bits.jsx";
import { ResourceListPage, updatedColumn } from "./ResourceListPage.jsx";

const storageOf = (row) => (row.uri?.startsWith("s3://") ? "S3" : "HTTPS");
const formatLabel = (row) =>
  ARTIFACT_FORMATS[row.format]?.label ?? row.format ?? "—";

export function TemplatesPage() {
  const load = useCallback(
    async (q) => (await api.listTemplates({ q })).templates,
    [],
  );
  const remove = useCallback((row) => api.deleteTemplate(row.id), []);
  const search = useCallback(
    (row) => [row.name, row.uri, row.format, formatLabel(row)],
    [],
  );

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Template",
        primary: true,
        sortable: true,
        width: "28%",
        value: (row) => row.name,
      },
      {
        key: "format",
        header: "Format",
        sortable: true,
        width: "120px",
        value: formatLabel,
        render: (row) => <Tag tone="brand">{formatLabel(row)}</Tag>,
      },
      {
        key: "storage",
        header: "Storage",
        sortable: true,
        width: "104px",
        hideBelow: "sm",
        value: storageOf,
        render: (row) => <Tag>{storageOf(row)}</Tag>,
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
      breadcrumbs={[{ label: "Configuration" }, { label: "Templates" }]}
      title="Templates"
      description="Reusable text or Markdown documents stored in S3 and injected into assigned agents."
      newHref="/templates/new"
      newLabel="New template"
      singular="template"
      plural="templates"
      emptyIcon="document"
      emptyDescription="Upload a reusable text or Markdown template."
      searchPlaceholder="Search name, format or location"
      editHref={(row) => `/templates/${row.id}/edit`}
      columns={columns}
      load={load}
      remove={remove}
      search={search}
    />
  );
}

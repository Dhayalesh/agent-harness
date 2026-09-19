import { useCallback, useMemo } from "react";
import { api } from "../api.js";
import { MonoValue, StatusPill, Tag } from "../components/Bits.jsx";
import { CellStack } from "../components/DataTable.jsx";
import { ResourceListPage, updatedColumn } from "./ResourceListPage.jsx";

const count = (value) => (value ? value.toLocaleString() : "—");

export function ModelProvidersPage() {
  const load = useCallback(
    async (q) => (await api.listModelProviders({ q })).modelProviders,
    [],
  );
  const remove = useCallback((row) => api.deleteModelProvider(row.id), []);
  const search = useCallback(
    (row) => [row.name, row.provider, row.model, row.baseURL],
    [],
  );

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Provider",
        primary: true,
        sortable: true,
        width: "26%",
        value: (row) => row.name,
        render: (row) => (
          <CellStack title={row.name} subtitle={row.model} mono />
        ),
      },
      {
        key: "provider",
        header: "Type",
        sortable: true,
        width: "116px",
        value: (row) => row.provider,
        render: (row) => <Tag tone="brand">{row.provider}</Tag>,
      },
      {
        key: "baseURL",
        header: "Endpoint",
        width: "24%",
        hideBelow: "lg",
        value: (row) => row.baseURL,
        render: (row) =>
          row.baseURL ? (
            <MonoValue className="line-clamp-1">{row.baseURL}</MonoValue>
          ) : (
            <span className="text-warning">Not configured</span>
          ),
      },
      {
        key: "context",
        header: "Context",
        sortable: true,
        numeric: true,
        width: "104px",
        hideBelow: "xl",
        value: (row) => row.capabilities?.contextWindow,
        render: (row) => count(row.capabilities?.contextWindow),
      },
      {
        key: "maxOutput",
        header: "Max out",
        sortable: true,
        numeric: true,
        width: "100px",
        hideBelow: "xl",
        value: (row) => row.capabilities?.maxOutputTokens,
        render: (row) => count(row.capabilities?.maxOutputTokens),
      },
      {
        key: "state",
        header: "State",
        width: "182px",
        value: (row) => (row.enabled ? "enabled" : "disabled"),
        render: (row) => (
          <span className="flex flex-wrap items-center gap-1">
            <StatusPill status={row.enabled ? "enabled" : "disabled"} />
            {row.isDefault && <StatusPill status="default" />}
            {!row.hasApiKey && <StatusPill status="missing" />}
          </span>
        ),
      },
      updatedColumn(),
    ],
    [],
  );

  return (
    <ResourceListPage
      breadcrumbs={[{ label: "Configuration" }, { label: "Model providers" }]}
      title="Model providers"
      description="Reusable model endpoints and capability limits sent to the AgentCore runtime with an invocation."
      newHref="/model-providers/new"
      newLabel="New provider"
      singular="model provider"
      plural="providers"
      emptyIcon="models"
      emptyDescription="Connect a model before composing an agent."
      searchPlaceholder="Search name, type or model"
      editHref={(row) => `/model-providers/${row.id}/edit`}
      columns={columns}
      load={load}
      remove={remove}
      search={search}
    />
  );
}

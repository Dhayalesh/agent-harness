import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import {
  EmptyState,
  ErrorNote,
  StatusPill,
  duration,
  relative,
  tokens,
  when,
} from "../components/Bits.jsx";
import { CellStack, DataTable } from "../components/DataTable.jsx";
import { PageShell } from "../components/PageShell.jsx";
import {
  Toolbar,
  ToolbarButton,
  ToolbarSearch,
  ToolbarSelect,
  ToolbarSpacer,
} from "../components/Toolbar.jsx";
import { Tooltip } from "@/components/ui/tooltip";

// "all"rather than ""because an empty string is not a usable collection key.
const statusOptions = [
  { key: "all", label: "All statuses" },
  { key: "success", label: "Success" },
  { key: "error", label: "Error" },
  { key: "running", label: "Running" },
];

export function RunsPage() {
  const [runs, setRuns] = useState(null);
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { runs: found } = await api.listRuns({
        status: status === "all" ? undefined : status,
        limit: 100,
      });
      setRuns(found);
    } catch (caught) {
      setError(caught);
      setRuns([]);
    } finally {
      setRefreshing(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  // Status is a server-side filter; the free-text search is local, so narrowing a
  // loaded page costs nothing and works against servers that ignore `q` on runs.
  const visible = useMemo(() => {
    if (!runs || !query.trim()) return runs;
    const needle = query.trim().toLowerCase();
    return runs.filter((run) =>
      [run.agentName, run.prompt]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [runs, query]);

  const columns = useMemo(
    () => [
      {
        key: "agent",
        header: "Agent / prompt",
        primary: true,
        sortable: true,
        value: (run) => run.agentName,
        width: "34%",
        render: (run) => (
          <Tooltip
            content={run.prompt}
            side="top"
            align="start"
            delayDuration={400}
          >
            <CellStack title={run.agentName} subtitle={run.prompt} />
          </Tooltip>
        ),
      },
      {
        key: "status",
        header: "Status",
        sortable: true,
        width: "110px",
        value: (run) => run.status,
        render: (run) => <StatusPill status={run.status} />,
      },
      {
        key: "turns",
        header: "Turns",
        sortable: true,
        numeric: true,
        width: "80px",
        hideBelow: "sm",
        value: (run) => run.turns,
      },
      {
        key: "tokens",
        header: "Tokens",
        sortable: true,
        numeric: true,
        width: "110px",
        hideBelow: "sm",
        value: (run) =>
          run.usage?.totalTokens ??
          (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0),
        render: (run) => tokens(run.usage),
      },
      {
        key: "duration",
        header: "Duration",
        sortable: true,
        numeric: true,
        width: "104px",
        hideBelow: "md",
        value: (run) => run.durationMs,
        render: (run) => duration(run.durationMs),
      },
      {
        key: "createdAt",
        header: "When",
        sortable: true,
        sortType: "date",
        align: "right",
        width: "116px",
        value: (run) => run.createdAt,
        render: (run) => (
          <Tooltip content={when(run.createdAt)} delayDuration={300}>
            <span className="whitespace-nowrap text-default-500">
              {relative(run.createdAt)}
            </span>
          </Tooltip>
        ),
      },
    ],
    [],
  );

  return (
    <PageShell
      breadcrumbs={[{ label: "Operations" }, { label: "Runs" }]}
      title="Runs"
      description="Every AgentCore invocation this console sent. The runtime keeps none of this — the row is written here."
      actions={
        <ToolbarButton
          icon="refresh"
          busy={refreshing}
          disabled={refreshing}
          onClick={() => void load()}
          className="h-9"
        >
          Refresh
        </ToolbarButton>
      }
    >
      <ErrorNote error={error} />

      <Toolbar>
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          label="Search runs by agent or prompt"
          placeholder="Search agent or prompt"
        />
        <ToolbarSelect
          value={status}
          onChange={setStatus}
          options={statusOptions}
          label="Filter by status"
        />
        <ToolbarSpacer />
      </Toolbar>

      <DataTable
        caption="Runs"
        columns={columns}
        rows={visible}
        loading={runs === null}
        skeletonRows={8}
        to={(run) => `/runs/${run.id}`}
        defaultSort={{ key: "createdAt", dir: "desc" }}
        total={runs?.length}
        totalLabel="runs"
        actions={(run) => [
          {
            key: "open",
            label: "Open run",
            icon: "external",
            to: `/runs/${run.id}`,
          },
        ]}
        empty={
          <EmptyState
            icon="runs"
            title={
              query || status !== "all"
                ? "No runs match these filters"
                : "No runs recorded"
            }
            description={
              query || status !== "all"
                ? "Clear the search or choose a different status."
                : "Start a chat with an agent and its invocations will appear here."
            }
          />
        }
      />
    </PageShell>
  );
}

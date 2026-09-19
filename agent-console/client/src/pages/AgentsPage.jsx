import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  AgentAvatar,
  EmptyState,
  ErrorNote,
  StatusPill,
  relative,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { CellStack, DataTable } from "../components/DataTable.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels } from "../components/Skeleton.jsx";
import { useToast } from "../components/Toast.jsx";
import {
  Toolbar,
  ToolbarSearch,
  ToolbarSegmented,
  ToolbarSpacer,
} from "../components/Toolbar.jsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";

const VIEW_KEY = "enterprise-agents:agents-view";

const viewOptions = [
  { key: "table", label: "Table view", icon: "layoutList" },
  { key: "grid", label: "Card view", icon: "layoutGrid" },
];

export function AgentsPage() {
  const [agents, setAgents] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { toast } = useToast();

  // A collection this varied is read two ways — scanned as a list, or browsed as
  // cards — so the choice is remembered rather than reset on every visit.
  const [view, setView] = useState(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "grid"
        ? "grid"
        : "table";
    } catch {
      return "table";
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Non-persistent preference is still applied for this session.
    }
  }, [view]);

  const load = useCallback(async (q) => {
    setError(null);
    try {
      const result = await api.listAgents({ q });
      setAgents(result.agents ?? []);
    } catch (caught) {
      setError(caught);
      setAgents([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const remove = async (agent) => {
    const confirmed = await confirm({
      title: "Delete agent",
      body: `Delete "${agent.name}"? Existing run and chat records are kept.`,
      confirmLabel: "Delete agent",
    });
    if (!confirmed) return;
    try {
      await api.deleteAgent(agent.id);
      toast({ title: "Agent deleted", description: agent.name });
      await load(query);
    } catch (caught) {
      setError(caught);
      toast({
        title: "Could not delete agent",
        description: caught.message,
        tone: "danger",
      });
    }
  };

  const rowActions = (agent) => [
    { key: "chat", label: "Open chat", icon: "chat", to: `/chat/${agent.id}` },
    {
      key: "edit",
      label: "Edit agent",
      icon: "edit",
      to: `/agents/${agent.id}/edit`,
    },
    {
      key: "delete",
      label: `Delete ${agent.name}`,
      icon: "trash",
      tone: "danger",
      onClick: () => remove(agent),
    },
  ];

  const columns = useMemo(
    () => [
      {
        key: "name",
        header: "Agent",
        primary: true,
        sortable: true,
        width: "28%",
        value: (agent) => agent.name,
        render: (agent) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <AgentAvatar name={agent.name} size="xs" />
            <CellStack
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{agent.name}</span>
                  {agent.resolved?.ready === false && (
                    <Tooltip
                      content={
                        agent.resolved?.issues?.[0]?.message ??
                        agent.resolved?.issues?.[0] ??
                        "Configuration needs attention."
                      }
                    >
                      <span className="shrink-0 text-warning">
                        <Icon name="alert" className="h-3.5 w-3.5" />
                      </span>
                    </Tooltip>
                  )}
                </span>
              }
              subtitle={agent.description || "No description"}
            />
          </span>
        ),
      },
      {
        key: "model",
        header: "Model",
        sortable: true,
        width: "18%",
        hideBelow: "md",
        value: (agent) =>
          agent.model ?? agent.resolved?.modelProvider?.model ?? "",
        render: (agent) => (
          <CellStack
            title={
              <span className="font-mono text-tiny">
                {agent.model ?? agent.resolved?.modelProvider?.model ?? "—"}
              </span>
            }
            subtitle={agent.resolved?.modelProvider?.name ?? "No provider"}
          />
        ),
      },
      {
        key: "tools",
        header: "Tools",
        sortable: true,
        numeric: true,
        width: "84px",
        hideBelow: "lg",
        value: (agent) => agent.tools?.length ?? 0,
      },
      {
        key: "mcp",
        header: "MCP",
        sortable: true,
        numeric: true,
        width: "80px",
        hideBelow: "lg",
        value: (agent) => agent.mcpServerIds?.length ?? 0,
      },
      {
        key: "skills",
        header: "Skills",
        sortable: true,
        numeric: true,
        width: "84px",
        hideBelow: "lg",
        value: (agent) => agent.skills?.length ?? 0,
      },
      {
        key: "state",
        header: "State",
        width: "112px",
        value: (agent) => (agent.enabled ? "enabled" : "disabled"),
        render: (agent) => (
          <span className="flex flex-wrap items-center gap-1">
            <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
            {agent.isDefault && <StatusPill status="default" />}
          </span>
        ),
      },
      {
        key: "updatedAt",
        header: "Updated",
        sortable: true,
        sortType: "date",
        align: "right",
        width: "112px",
        hideBelow: "sm",
        value: (agent) => agent.updatedAt ?? agent.createdAt,
        render: (agent) => (
          <Tooltip
            delayDuration={300}
            content={when(agent.updatedAt ?? agent.createdAt)}
          >
            <span className="whitespace-nowrap text-default-500">
              {relative(agent.updatedAt ?? agent.createdAt)}
            </span>
          </Tooltip>
        ),
      },
    ],
    [],
  );

  const emptyState = (
    <EmptyState
      icon="agents"
      title={query ? "No agents match this search" : "No agents yet"}
      description={
        query
          ? "Try a different search term."
          : "An agent composes a model provider with tools, MCP servers, and skills."
      }
      action={
        !query && (
          <Button asChild>
            <Link to="/agents/new">Create agent</Link>
          </Button>
        )
      }
    />
  );

  return (
    <PageShell
      breadcrumbs={[{ label: "Configuration" }, { label: "Agents" }]}
      title="Agents"
      description="Compose a model provider, local tools, MCP servers, and skills into a runnable definition."
      actions={
        <Button asChild className="font-semibold">
          <Link to="/agents/new">
            <Icon name="plus" className="h-4 w-4" />
            New agent
          </Link>
        </Button>
      }
    >
      <ErrorNote error={error} />

      <Toolbar>
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          label="Search agents"
          placeholder="Search agents"
        />
        <ToolbarSpacer />
        <ToolbarSegmented
          value={view}
          onChange={setView}
          options={viewOptions}
          label="Result layout"
        />
      </Toolbar>

      {view === "table" ? (
        <DataTable
          caption="Agents"
          columns={columns}
          rows={agents}
          loading={agents === null}
          skeletonRows={6}
          to={(agent) => `/agents/${agent.id}`}
          defaultSort={{ key: "updatedAt", dir: "desc" }}
          actions={rowActions}
          totalLabel="agents"
          empty={emptyState}
        />
      ) : agents === null ? (
        <SkeletonPanels count={3} />
      ) : agents.length === 0 ? (
        emptyState
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {agents.map((agent) => (
            <li key={agent.id} className="min-w-0">
              <AgentCard agent={agent} onDelete={() => remove(agent)} />
            </li>
          ))}
        </ul>
      )}

      {confirmDialog}
    </PageShell>
  );
}

/**
 * The card view. Same facts as a table row, arranged for browsing rather than
 * comparing: the description gets room and the counts become a compact footer.
 */
function AgentCard({ agent, onDelete }) {
  const provider = agent.resolved?.modelProvider;
  const issue =
    agent.resolved?.ready === false
      ? (agent.resolved?.issues?.[0]?.message ??
        agent.resolved?.issues?.[0] ??
        "Configuration needs attention.")
      : null;

  return (
    <Card className="group h-full transition-colors duration-200 hover:border-primary/25 hover:bg-primary/[0.02] focus-within:border-primary/40">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentAvatar name={agent.name} />
          <div className="min-w-0 flex-1">
            <Link
              to={`/agents/${agent.id}`}
              className="block truncate text-small font-semibold text-foreground transition-colors hover:text-primary"
            >
              {agent.name}
            </Link>
            <span className="mt-0.5 block truncate font-mono text-tiny text-default-500">
              {agent.model ?? provider?.model ?? "No model"}
            </span>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
            {agent.isDefault && <StatusPill status="default" />}
          </div>
        </div>

        <p className="line-clamp-2 min-h-[2.5em] text-tiny leading-5 text-default-500">
          {agent.description || "No description."}
        </p>

        {issue && (
          <p className="flex items-start gap-1.5 border-l-2 border-l-warning bg-warning/[0.07] px-2 py-1.5 text-tiny text-warning-600 dark:text-warning-400">
            <Icon name="alert" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{issue}</span>
          </p>
        )}

        <div className="flex items-center gap-3 border-t border-divider pt-2.5 text-tiny text-default-500">
          <CardCount label="tools" value={agent.tools?.length ?? 0} />
          <CardCount label="MCP" value={agent.mcpServerIds?.length ?? 0} />
          <CardCount label="skills" value={agent.skills?.length ?? 0} />

          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CardAction
              to={`/chat/${agent.id}`}
              icon="chat"
              label="Open chat"
            />
            <CardAction
              to={`/agents/${agent.id}/edit`}
              icon="edit"
              label="Edit agent"
            />
            <Tooltip content={`Delete ${agent.name}`} delayDuration={300}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${agent.name}`}
                onClick={onDelete}
                className="h-7 w-7 text-default-500 hover:bg-danger/10 hover:text-danger"
              >
                <Icon name="trash" className="h-4 w-4" />
              </Button>
            </Tooltip>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function CardCount({ label, value }) {
  return (
    <span className="flex items-baseline gap-1">
      <strong className="metric font-semibold text-foreground">{value}</strong>
      {label}
    </span>
  );
}

function CardAction({ to, icon, label }) {
  return (
    <Tooltip content={label} delayDuration={300}>
      <Link
        to={to}
        aria-label={label}
        className="grid h-7 w-7 place-items-center rounded-md text-default-500 transition-colors duration-200 hover:bg-primary/[0.08] hover:text-primary"
      >
        <Icon name={icon} className="h-4 w-4" />
      </Link>
    </Tooltip>
  );
}

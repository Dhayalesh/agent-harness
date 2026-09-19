import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  SectionCard,
  StatusPill,
  duration,
  relative,
  tokens,
  when,
} from "../components/Bits.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { SkeletonPanels, SkeletonStats } from "../components/Skeleton.jsx";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";

/** The panel-header "View all" affordance, as a router link rather than an anchor. */
function PanelLink({ to, children }) {
  return (
    <Link
      to={to}
      className="shrink-0 text-small font-medium text-primary transition-colors hover:underline"
    >
      {children}
    </Link>
  );
}

const inventory = [
  { key: "agents", label: "Agents", to: "/agents", icon: "agents" },
  {
    key: "modelProviders",
    label: "Models",
    to: "/model-providers",
    icon: "models",
  },
  { key: "mcpServers", label: "MCP servers", to: "/mcp-servers", icon: "plug" },
  { key: "skills", label: "Skills", to: "/skills", icon: "skills" },
];

/**
 * The workspace at a glance: is it healthy, what is configured, what happened
 * recently, and what is the one thing to do next.
 *
 * The previous version led with a full-width saturated hero asking "what do you
 * want your agent to do?"— a landing page gesture. An operations overview should
 * open with numbers, because the first question on returning to a console is
 * whether anything is broken, not what to build.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.dashboard(), api.listAgents()])
      .then(([summary, agentResult]) => {
        if (cancelled) return;
        setDashboard(summary.dashboard ?? summary);
        const found = agentResult.agents ?? [];
        setAgents(found);
        const preferred = found.find(
          (agent) => agent.isDefault && agent.enabled,
        );
        setSelectedAgent(
          (preferred ?? found.find((agent) => agent.enabled) ?? found[0])?.id ??
            "",
        );
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = dashboard?.counts ?? {};
  const recentRuns = dashboard?.recentRuns ?? [];
  const recentChats = dashboard?.recentChats ?? [];
  const loading = !dashboard && !error;

  /**
   * Derived from the runs the dashboard already returns rather than from a new
   * endpoint. It is a sample, not a global rate, and the label says so.
   */
  const health = useMemo(() => {
    if (recentRuns.length === 0) return null;
    const failed = recentRuns.filter((run) => run.status === "error").length;
    const totalTokens = recentRuns.reduce(
      (sum, run) => sum + (run.usage?.totalTokens ?? 0),
      0,
    );
    return {
      failed,
      succeeded: recentRuns.length - failed,
      successRate: Math.round(
        ((recentRuns.length - failed) / recentRuns.length) * 100,
      ),
      totalTokens,
      sample: recentRuns.length,
    };
  }, [recentRuns]);

  const runColumns = useMemo(
    () => [
      {
        key: "agentName",
        header: "Agent",
        primary: true,
        sortable: true,
        width: "34%",
        value: (run) => run.agentName,
      },
      {
        key: "status",
        header: "Status",
        width: "110px",
        value: (run) => run.status,
        render: (run) => <StatusPill status={run.status} />,
      },
      {
        key: "tokens",
        header: "Tokens",
        numeric: true,
        width: "104px",
        hideBelow: "sm",
        value: (run) => run.usage?.totalTokens,
        render: (run) => tokens(run.usage),
      },
      {
        key: "duration",
        header: "Duration",
        numeric: true,
        width: "100px",
        hideBelow: "md",
        value: (run) => run.durationMs,
        render: (run) => duration(run.durationMs),
      },
      {
        key: "createdAt",
        header: "When",
        align: "right",
        width: "108px",
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

  const setupSteps = [
    {
      complete: (counts.modelProviders ?? 0) > 0,
      label: "Connect a model provider",
      hint: "An agent needs somewhere to send its turns.",
      to: "/model-providers/new",
    },
    {
      complete: (counts.agents ?? 0) > 0,
      label: "Create an agent",
      hint: "Compose the provider with tools and skills.",
      to: "/agents/new",
    },
    {
      complete: (counts.chats ?? 0) > 0,
      label: "Start a chat",
      hint: "Confirm the definition actually answers.",
      to: "/chat",
    },
  ];
  const remaining = setupSteps.filter((step) => !step.complete).length;

  return (
    <PageShell
      breadcrumbs={[{ label: "Workspace" }, { label: "Dashboard" }]}
      title="Dashboard"
      description="Inventory, recent activity, and the state of this workspace."
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

      {loading ? (
        <div className="flex flex-col gap-4">
          <SkeletonStats />
          <SkeletonPanels count={2} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Outcomes first, inventory second. Ruled columns, not four cards. */}
          <div className="grid grid-cols-2 divide-x divide-divider border-y border-divider xl:grid-cols-4">
            <Metric
              label="Recent success rate"
              value={health ? `${health.successRate}%` : "—"}
              detail={health ? `Last ${health.sample} runs` : "No runs yet"}
              tone={
                !health
                  ? "neutral"
                  : health.successRate === 100
                    ? "success"
                    : health.successRate >= 80
                      ? "warning"
                      : "danger"
              }
            />
            <Metric
              label="Failed runs"
              value={health ? health.failed : "—"}
              detail={health ? `of ${health.sample} sampled` : "No runs yet"}
              tone={health?.failed ? "danger" : "neutral"}
              to={health?.failed ? "/runs" : undefined}
            />
            <Metric
              label="Tokens used"
              value={
                health?.totalTokens
                  ? health.totalTokens.toLocaleString()
                  : "—"
              }
              detail="Across sampled runs"
            />
            <Metric
              label="Saved chats"
              value={counts.chats ?? 0}
              detail="Persisted threads"
              to="/chat"
            />
          </div>

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(300px,0.85fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <SectionCard
                title="Recent runs"
                description="Latest AgentCore activity across this workspace."
                action={<PanelLink to="/runs">View all</PanelLink>}
                bodyClassName="p-0"
              >
                <DataTable
                  caption="Recent runs"
                  columns={runColumns}
                  rows={recentRuns}
                  to={(run) => `/runs/${run.id}`}
                  maxHeight="none"
                  className="rounded-none border-0 shadow-none"
                  totalLabel="recent runs"
                  empty={
                    <p className="py-6 text-center text-small text-default-500">
                      No runs yet. Open a chat and the invocations will appear
                      here.
                    </p>
                  }
                />
              </SectionCard>

              {/* The build affordance, now sized like a control rather than a banner. */}
              <SectionCard
                title="Open a chat"
                description="Pick an enabled agent and start a persisted session."
              >
                {agents.length ? (
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                    <Select
                      value={selectedAgent || undefined}
                      onValueChange={setSelectedAgent}
                    >
                      <SelectTrigger
                        aria-label="Agent to chat with"
                        className="border-divider bg-content1 sm:max-w-sm"
                      >
                        <SelectValue placeholder="Choose an agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          // A disabled agent stays listed but unselectable, so it is
                          // clear why it cannot be chosen rather than absent.
                          <SelectItem
                            key={agent.id}
                            value={agent.id}
                            disabled={!agent.enabled}
                            description={
                              agent.enabled ? undefined : "Disabled"
                            }
                          >
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      className="font-semibold"
                      disabled={!selectedAgent}
                      onClick={() => navigate(`/chat/${selectedAgent}`)}
                    >
                      Start chat
                      <Icon name="arrow" className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-small text-default-500">
                    Create an agent after adding a model provider.
                  </p>
                )}
              </SectionCard>
            </div>

            <aside className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1">
              <SectionCard
                title="Inventory"
                description="What is configured in this workspace."
                bodyClassName="p-0"
              >
                <ul className="divide-y divide-divider">
                  {inventory.map((entry) => (
                    <li key={entry.key}>
                      <Link
                        to={entry.to}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-content2/70"
                      >
                        <Icon
                          name={entry.icon}
                          className="h-4 w-4 shrink-0 text-default-400"
                        />
                        <span className="min-w-0 flex-1 truncate text-small text-foreground">
                          {entry.label}
                        </span>
                        <strong className="metric text-small font-semibold text-foreground">
                          {counts[entry.key] ?? 0}
                        </strong>
                        <Icon
                          name="chevronRight"
                          className="h-3.5 w-3.5 shrink-0 text-default-400"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </SectionCard>

              {/* Hidden once complete: a permanent checklist of done things is noise. */}
              {remaining > 0 && (
                <SectionCard
                  title="Finish setup"
                  description={`${remaining} step${remaining === 1 ? "" : "s"} to a first answer.`}
                >
                  <ol className="flex flex-col gap-2">
                    {setupSteps.map((step) => (
                      <SetupStep key={step.label} {...step} />
                    ))}
                  </ol>
                </SectionCard>
              )}

              <SectionCard
                title="Recent chats"
                description="Jump back into a saved thread."
                action={<PanelLink to="/chat">All chats</PanelLink>}
                bodyClassName="p-0"
              >
                {recentChats.length ? (
                  <ul className="divide-y divide-divider">
                    {recentChats.slice(0, 5).map((chat) => (
                      <li key={chat.id}>
                        <Link
                          to={`/chat/${chat.agentId}?chat=${chat.id}`}
                          className="block px-4 py-2.5 transition-colors hover:bg-content2/70"
                        >
                          <span className="block truncate text-small font-medium text-foreground">
                            {chat.title || chat.agentName}
                          </span>
                          <span className="mt-0.5 block truncate text-tiny text-default-500">
                            {chat.agentName} · {relative(chat.updatedAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-4 py-3 text-small text-default-500">
                    No saved chats yet.
                  </p>
                )}
              </SectionCard>
            </aside>
          </div>
        </div>
      )}
    </PageShell>
  );
}

const METRIC_TONE = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * A single number with the context needed to judge it. Becomes a link only when
 * there is somewhere useful to go — a failure count worth investigating.
 */
function Metric({ label, value, detail, tone = "neutral", to }) {
  const body = (
    <>
      <span className="label block">{label}</span>
      {/*
        Light, large and tightly tracked. A bold numeral shouts; a light one at
        size reads as instrumentation, which is the register a console wants.
      */}
      <strong className={cn("display-lg mt-3 block truncate", METRIC_TONE[tone])}>
        {value}
      </strong>
      <span className="mt-2.5 block truncate text-tiny text-default-500">
        {detail}
      </span>
    </>
  );

  // No box. Metrics are separated from each other by rules, like columns of a
  // printed table, and the group as a whole is bounded by the strip's own borders.
  const shell = "min-w-0 px-4 py-4 first:pl-0";

  return to ? (
    <Link
      to={to}
      className={cn(shell, "group block rounded-lg transition-colors duration-200 hover:bg-primary/[0.04]")}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

function SetupStep({ complete, label, hint, to }) {
  return (
    <li>
      <Link
        to={to}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-200",
          complete
            ? "border-success/20 bg-success/[0.04] hover:bg-success/[0.07]"
            : "border-divider bg-content1 hover:border-primary/20 hover:bg-primary/[0.04]",
        )}
      >
        <span
          className={cn(
            "mt-px grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border text-micro",
            complete
              ? "border-success/40 bg-success/15 text-success"
              : "border-default-300 text-default-400",
          )}
        >
          {complete && (
            <Icon name="check" className="h-2.5 w-2.5" strokeWidth={3} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block text-small",
              complete
                ? "text-default-500 line-through decoration-default-300"
                : "font-medium text-foreground",
            )}
          >
            {label}
          </span>
          {!complete && (
            <span className="mt-0.5 block text-tiny text-default-500">
              {hint}
            </span>
          )}
        </span>
        {!complete && (
          <Icon
            name="arrow"
            className="mt-0.5 h-4 w-4 shrink-0 text-default-400"
          />
        )}
      </Link>
    </li>
  );
}

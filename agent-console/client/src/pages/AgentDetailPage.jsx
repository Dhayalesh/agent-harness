import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { ARTIFACT_FORMATS } from "../components/artifacts/artifact-utils.js";
import {
  AgentAvatar,
  ErrorNote,
  MonoValue,
  SectionCard,
  StatusPill,
  Tag,
  duration,
  relative,
  tokens,
  when,
} from "../components/Bits.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Icon } from "../components/Icon.jsx";
import {
  DefinitionRow,
  PageShell,
  PageTabs,
} from "../components/PageShell.jsx";
import { SkeletonPanels, SkeletonStats } from "../components/Skeleton.jsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function AgentDetailPage() {
  const { id } = useParams();
  const [agent, setAgent] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runCount, setRunCount] = useState(0);
  const [chatCount, setChatCount] = useState(0);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("overview");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [agentResult, runResult] = await Promise.all([
        api.getAgent(id),
        api.listRuns({ agentId: id, limit: 10 }),
      ]);
      setAgent(agentResult.agent);
      setRunCount(
        agentResult.runCount ?? runResult.total ?? runResult.runs?.length ?? 0,
      );
      setChatCount(agentResult.chatCount ?? 0);
      setRuns(runResult.runs ?? []);
    } catch (caught) {
      setError(caught);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runColumns = useMemo(
    () => [
      {
        key: "status",
        header: "Status",
        width: "110px",
        primary: true,
        value: (run) => run.status,
        render: (run) => <StatusPill status={run.status} />,
      },
      {
        key: "turns",
        header: "Turns",
        sortable: true,
        numeric: true,
        width: "84px",
        value: (run) => run.turns,
      },
      {
        key: "tokens",
        header: "Tokens",
        sortable: true,
        numeric: true,
        width: "110px",
        value: (run) => run.usage?.totalTokens,
        render: (run) => tokens(run.usage),
      },
      {
        key: "duration",
        header: "Duration",
        sortable: true,
        numeric: true,
        width: "108px",
        hideBelow: "sm",
        value: (run) => run.durationMs,
        render: (run) => duration(run.durationMs),
      },
      {
        key: "createdAt",
        header: "When",
        sortable: true,
        sortType: "date",
        align: "right",
        value: (run) => run.createdAt,
        render: (run) => (
          <span className="whitespace-nowrap text-default-500">
            {relative(run.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  if (!agent) {
    return error ? (
      <ErrorNote error={error} />
    ) : (
      <div className="flex flex-col gap-4">
        <SkeletonStats />
        <SkeletonPanels count={2} />
      </div>
    );
  }

  const resolved = agent.resolved ?? {};
  const provider = resolved.modelProvider;
  const mcpServers = resolved.mcpServers ?? [];
  const skills = resolved.skills ?? [];
  const templates = resolved.templates ?? [];
  const issues = resolved.issues ?? [];
  const integrationCount = mcpServers.length + skills.length + templates.length;

  const tabs = [
    { key: "overview", label: "Overview", icon: "settings" },
    { key: "prompt", label: "System prompt", icon: "document" },
    {
      key: "tools",
      label: "Tools",
      icon: "tool",
      count: agent.tools?.length ?? 0,
    },
    {
      key: "integrations",
      label: "Integrations",
      icon: "plug",
      count: integrationCount,
    },
    { key: "runs", label: "Runs", icon: "runs", count: runCount },
  ];

  return (
    <PageShell
      breadcrumbs={[
        { label: "Configuration" },
        { label: "Agents", to: "/agents" },
        { label: agent.name },
      ]}
      title={agent.name}
      titleAdornment={<AgentAvatar name={agent.name} size="lg" />}
      status={
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
          {agent.isDefault && <StatusPill status="default" />}
          {agent.stream && <StatusPill status="streaming" />}
        </span>
      }
      description={agent.description || "No description."}
      actions={
        <>
          <Button asChild className="h-9 font-semibold">
            <Link to={`/chat/${agent.id}`}>
              <Icon name="chat" className="h-4 w-4" />
              Open chat
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-9 border-divider">
            <Link to={`/agents/${id}/edit`}>
              <Icon name="edit" className="h-4 w-4" />
              Edit
            </Link>
          </Button>
        </>
      }
      meta={[
        {
          label: "Model",
          value: agent.model ?? provider?.model ?? "—",
        },
        { label: "Provider", value: provider?.name ?? "Unresolved" },
        { label: "Runs", value: runCount, numeric: true },
        { label: "Chats", value: chatCount, numeric: true },
      ]}
      tabs={<PageTabs tabs={tabs} activeKey={tab} onChange={setTab} />}
    >
      <ErrorNote error={error} />

      {resolved.ready === false && (
        <Alert variant="warning" className="mb-4">
          <div className="min-w-0 flex-1">
            <AlertTitle>This agent is not ready to run.</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tiny">
                {issues.map((issue, index) => (
                  <li key={issue.code ?? index}>
                    {issue.message ?? String(issue)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </div>
        </Alert>
      )}

      {tab === "overview" && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          <SectionCard
            title="Model and provider"
            description="The stored definition resolved for AgentCore."
          >
            <dl className="flex flex-col">
              <DefinitionRow label="Provider">
                {provider?.id ? (
                  <Link
                    to={`/model-providers/${provider.id}/edit`}
                    className="font-medium text-primary hover:underline"
                  >
                    {provider.name}
                  </Link>
                ) : (
                  <MonoValue>{agent.modelProviderId}</MonoValue>
                )}
              </DefinitionRow>
              <DefinitionRow label="Provider type">
                {provider?.provider ? (
                  <Tag tone="brand">{provider.provider}</Tag>
                ) : (
                  "—"
                )}
              </DefinitionRow>
              <DefinitionRow label="Model">
                <MonoValue>{agent.model ?? provider?.model ?? "—"}</MonoValue>
              </DefinitionRow>
              <DefinitionRow
                label="Context window"
                hint="Reported by the provider record, not by the agent."
              >
                {provider?.capabilities?.contextWindow?.toLocaleString?.() ??
                  "Provider capability unavailable"}
              </DefinitionRow>
            </dl>
          </SectionCard>

          <SectionCard
            title="Execution limits"
            description="What bounds a single run of this definition."
          >
            <dl className="flex flex-col">
              <DefinitionRow label="Max turns">
                {agent.limits?.maxTurns ?? "Runtime default"}
              </DefinitionRow>
              <DefinitionRow label="Output ceiling">
                {agent.limits?.maxOutputTokens?.toLocaleString?.() ??
                  "Provider default"}
              </DefinitionRow>
              <DefinitionRow
                label="Compaction threshold"
                hint="How full the context may get before earlier turns are summarised."
              >
                {agent.limits?.compactionThresholdPercent === undefined
                  ? "Runtime default"
                  : `${agent.limits.compactionThresholdPercent}%`}
              </DefinitionRow>
              <DefinitionRow label="Streaming">
                {agent.stream ? "Requested" : "Off"}
              </DefinitionRow>
            </dl>
          </SectionCard>
        </div>
      )}

      {tab === "prompt" && (
        <SectionCard
          title="System prompt"
          description="Sent at the start of every turn."
          bodyClassName="p-0"
        >
          <ScrollArea className="max-h-[560px]">
            <pre className="message-text p-4 font-mono text-tiny">
              {agent.systemPrompt || "(none)"}
            </pre>
          </ScrollArea>
        </SectionCard>
      )}

      {tab === "tools" && (
        <SectionCard
          title="Local tools"
          description={`${agent.tools?.length ?? 0} tools available to this agent.`}
        >
          {agent.tools?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.map((tool) => (
                <span
                  key={tool}
                  className="inline-flex items-center gap-1.5 border border-divider bg-content2 px-2 py-1 font-mono text-tiny text-default-600"
                >
                  <Icon name="tool" className="h-3 w-3 text-default-400" />
                  {tool}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-small text-default-500">
              No local tools are enabled for this agent.
            </p>
          )}
        </SectionCard>
      )}

      {tab === "integrations" && (
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
          <IntegrationCard
            title="MCP servers"
            icon="plug"
            empty="No MCP servers attached."
            items={mcpServers.map((server) => ({
              id: server.id,
              title: server.missing ? server.id : server.name,
              href: server.missing ? null : `/mcp-servers/${server.id}/edit`,
              detail: server.transport,
              missing: server.missing,
            }))}
          />
          <IntegrationCard
            title="Skills"
            icon="skills"
            empty="No skills attached."
            items={skills.map((skill) => ({
              id: skill.id,
              title: skill.missing ? skill.id : skill.name,
              href: skill.missing ? null : `/skills/${skill.id}/edit`,
              detail: skill.uri,
              missing: skill.missing,
            }))}
          />
          <IntegrationCard
            title="Templates"
            icon="document"
            empty="No templates attached."
            items={templates.map((template) => ({
              id: template.id,
              title: template.missing ? template.id : template.name,
              href: template.missing ? null : `/templates/${template.id}/edit`,
              detail: template.missing
                ? undefined
                : `${
                    ARTIFACT_FORMATS[template.format ?? "html"]?.label ??
                    template.format ??
                    "HTML"
                  } · ${template.uri}`,
              missing: template.missing,
            }))}
          />
        </div>
      )}

      {tab === "runs" && (
        <DataTable
          caption="Recent runs for this agent"
          columns={runColumns}
          rows={runs}
          to={(run) => `/runs/${run.id}`}
          defaultSort={{ key: "createdAt", dir: "desc" }}
          totalLabel="recent runs"
          maxHeight="none"
          actions={(run) => [
            {
              key: "open",
              label: "Open run",
              icon: "external",
              to: `/runs/${run.id}`,
            },
          ]}
          empty={
            <p className="py-6 text-center text-small text-default-500">
              This agent has not run yet.
            </p>
          }
        />
      )}
    </PageShell>
  );
}

/**
 * One integration type per card. A record that references something which no longer
 * exists is called out rather than rendered as a dead link, because a missing MCP
 * server is the most likely reason an agent stops being runnable.
 */
function IntegrationCard({ title, icon, items, empty }) {
  return (
    <SectionCard
      title={title}
      action={
        <span className="metric text-tiny text-default-500">
          {items.length}
        </span>
      }
      bodyClassName={items.length ? "p-0" : "px-5 py-4"}
    >
      {items.length ? (
        <ul className="divide-y divide-divider">
          {items.map((item) => (
            <li key={item.id} className="min-w-0 px-4 py-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <Icon
                  name={icon}
                  className="h-3.5 w-3.5 shrink-0 text-default-400"
                />
                {item.href ? (
                  <Link
                    to={item.href}
                    className="min-w-0 truncate text-small font-medium text-primary hover:underline"
                  >
                    {item.title}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-small font-medium">
                    {item.title}
                  </span>
                )}
                {item.missing && <StatusPill status="missing" />}
              </span>
              {item.detail && (
                <span className="mt-0.5 block truncate pl-[22px] font-mono text-tiny text-default-500">
                  {item.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-default-500">{empty}</p>
      )}
    </SectionCard>
  );
}

import {
  Alert,
  Button,
  Code,
  Link as HeroLink,
  ScrollShadow,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  AgentAvatar,
  ErrorNote,
  Loading,
  MetaGrid,
  PageHeader,
  SectionCard,
  StatTile,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";

export function AgentDetailPage() {
  const { id } = useParams();
  const [agent, setAgent] = useState(null);
  const [runs, setRuns] = useState([]);
  const [runCount, setRunCount] = useState(0);
  const [chatCount, setChatCount] = useState(0);
  const [error, setError] = useState(null);

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

  if (!agent)
    return error ? <ErrorNote error={error} /> : <Loading what="agent" />;

  const resolved = agent.resolved ?? {};
  const provider = resolved.modelProvider;
  const mcpServers = resolved.mcpServers ?? [];
  const skills = resolved.skills ?? [];
  const issues = resolved.issues ?? [];

  return (
    <section>
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        description={agent.description || "No description."}
        avatar={<AgentAvatar name={agent.name} size="lg" />}
        actions={
          <>
            <Button
              as={Link}
              color="primary"
              radius="md"
              to={`/chat/${agent.id}`}
              startContent={<Icon name="chat" className="h-4 w-4" />}
            >
              Open chat
            </Button>
            <Button
              as={Link}
              variant="bordered"
              radius="md"
              to={`/agents/${id}/edit`}
              startContent={<Icon name="edit" className="h-4 w-4" />}
            >
              Edit
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {resolved.ready === false && (
        <Alert
          color="warning"
          variant="flat"
          title="This agent is not ready to run."
          classNames={{
            base: "mb-4 items-start border border-warning-200 dark:border-warning-500/25",
            title: "text-small font-semibold",
          }}
        >
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tiny">
            {issues.map((issue, index) => (
              <li key={issue.code ?? index}>{issue.message ?? String(issue)}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label="Status"
          value={agent.enabled ? "Enabled" : "Disabled"}
        />
        <StatTile
          label="Model"
          value={agent.model ?? provider?.model ?? "—"}
        />
        <StatTile label="Runs" value={runCount} />
        <StatTile label="Chats" value={chatCount} />
      </div>

      <div className="mb-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionCard
            title="Configuration"
            description="The stored definition resolved for AgentCore."
            action={
              <StatusPill status={agent.enabled ? "enabled" : "disabled"} />
            }
          >
            <MetaGrid
              wide
              items={[
                {
                  label: "Provider",
                  value: provider?.id ? (
                    <HeroLink
                      size="sm"
                      href={`/model-providers/${provider.id}/edit`}
                    >
                      {provider.name}
                    </HeroLink>
                  ) : (
                    agent.modelProviderId
                  ),
                },
                { label: "Provider type", value: provider?.provider ?? "—" },
                { label: "Default", value: agent.isDefault ? "yes" : "no" },
                {
                  label: "Streaming",
                  value: agent.stream ? "requested" : "off",
                },
                { label: "Max turns", value: agent.limits?.maxTurns ?? "—" },
                {
                  label: "Shrinks context at",
                  value: `${agent.limits?.compactionThresholdPercent ?? 90}%`,
                },
                {
                  label: "Output ceiling",
                  value:
                    agent.limits?.maxOutputTokens?.toLocaleString?.() ??
                    "provider default",
                },
              ]}
            />
          </SectionCard>

          <SectionCard
            title="System prompt"
            description="Sent at the start of every turn."
            bodyClassName="px-5 pb-5 pt-1"
          >
            <ScrollShadow className="max-h-[260px] rounded-medium border border-divider bg-content2">
              <pre className="message-text p-3.5 font-mono text-tiny">
                {agent.systemPrompt}
              </pre>
            </ScrollShadow>
          </SectionCard>
        </div>

        <div className="flex flex-col gap-4">
          <SectionCard
            title="Tools"
            description={`${agent.tools?.length ?? 0} local tools selected.`}
          >
            {agent.tools?.length ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((tool) => (
                  <Code key={tool} size="sm" className="text-tiny">
                    {tool}
                  </Code>
                ))}
              </div>
            ) : (
              <p className="text-small text-default-500">No local tools.</p>
            )}
          </SectionCard>

          <SectionCard
            title="Integrations"
            description="MCP servers and reusable skills."
          >
            <div className="flex flex-col gap-4">
              <IntegrationList
                heading="MCP servers"
                empty="No MCP servers."
                items={mcpServers.map((server) => ({
                  id: server.id,
                  title: server.missing ? server.id : server.name,
                  href: server.missing
                    ? null
                    : `/mcp-servers/${server.id}/edit`,
                  detail: server.transport,
                }))}
              />
              <IntegrationList
                heading="Skills"
                empty="No skills."
                items={skills.map((skill) => ({
                  id: skill.id,
                  title: skill.missing ? skill.id : skill.name,
                  href: skill.missing ? null : `/skills/${skill.id}/edit`,
                  detail: skill.uri,
                }))}
              />
            </div>
          </SectionCard>
        </div>
      </div>

      <SectionCard
        title="Recent runs"
        description="Latest turns executed by this definition."
        action={
          <HeroLink href="/runs" size="sm" className="shrink-0">
            View all
          </HeroLink>
        }
        bodyClassName="px-2 pb-2 pt-2"
      >
        <Table
          removeWrapper
          aria-label="Recent runs for this agent"
          classNames={{
            th: "bg-transparent text-[10px] uppercase tracking-wider text-default-500",
            td: "text-small",
          }}
        >
          <TableHeader>
            <TableColumn>When</TableColumn>
            <TableColumn>Status</TableColumn>
            <TableColumn>Turns</TableColumn>
            <TableColumn>Tokens</TableColumn>
            <TableColumn>Duration</TableColumn>
            <TableColumn hideHeader>Open</TableColumn>
          </TableHeader>
          <TableBody emptyContent="No runs yet.">
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="whitespace-nowrap">
                  {when(run.createdAt)}
                </TableCell>
                <TableCell>
                  <StatusPill status={run.status} />
                </TableCell>
                <TableCell className="text-default-500">{run.turns}</TableCell>
                <TableCell className="text-default-500">
                  {tokens(run.usage)}
                </TableCell>
                <TableCell className="text-default-500">
                  {duration(run.durationMs)}
                </TableCell>
                <TableCell>
                  <HeroLink href={`/runs/${run.id}`} size="sm">
                    Open
                  </HeroLink>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </section>
  );
}

function IntegrationList({ heading, items, empty }) {
  return (
    <div>
      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-default-500">
        {heading}
      </h3>
      {items.length ? (
        <ul className="divide-y divide-divider overflow-hidden rounded-medium border border-divider bg-content2">
          {items.map((item) => (
            <li key={item.id} className="min-w-0 px-3 py-2.5">
              {item.href ? (
                <HeroLink
                  href={item.href}
                  size="sm"
                  className="block truncate font-medium"
                >
                  {item.title}
                </HeroLink>
              ) : (
                <span className="block truncate text-small font-medium">
                  {item.title}
                </span>
              )}
              <span className="mt-0.5 block truncate text-tiny text-default-500">
                {item.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-default-500">{empty}</p>
      )}
    </div>
  );
}

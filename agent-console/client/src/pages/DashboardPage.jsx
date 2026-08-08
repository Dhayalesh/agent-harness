import {
  Button,
  Card,
  CardBody,
  Link as HeroLink,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  PageHeader,
  SectionCard,
  StatusPill,
  duration,
  relative,
  tokens,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";

const countCards = [
  {
    key: "agents",
    label: "Agents",
    to: "/agents",
    detail: "Runnable definitions",
    icon: "agents",
  },
  {
    key: "modelProviders",
    label: "Models",
    to: "/model-providers",
    detail: "Provider connections",
    icon: "models",
  },
  {
    key: "mcpServers",
    label: "MCP servers",
    to: "/mcp-servers",
    detail: "Tool integrations",
    icon: "plug",
  },
  {
    key: "skills",
    label: "Skills",
    to: "/skills",
    detail: "Reusable instructions",
    icon: "skills",
  },
];

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
        const preferred = found.find((agent) => agent.isDefault && agent.enabled);
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

  if (!dashboard && !error) return <Loading what="workspace" />;

  const counts = dashboard?.counts ?? {};
  const recentRuns = dashboard?.recentRuns ?? [];
  const recentChats = dashboard?.recentChats ?? [];

  return (
    <section>
      <PageHeader
        large
        eyebrow="Workspace overview"
        title="Build, connect, and run your agents"
        description="Configure the pieces once, compose them into an agent, then test the result in chat."
        actions={
          <Button
            color="primary"
            radius="md"
            href="/agents/new"
            startContent={<Icon name="plus" className="h-4 w-4" />}
          >
            New agent
          </Button>
        }
      />

      <ErrorNote error={error} />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {countCards.map((card) => (
          <Card
            key={card.key}
            as={Link}
            to={card.to}
            isPressable
            shadow="none"
            className="border border-divider bg-content1 transition-colors data-[hover=true]:border-primary/40"
          >
            <CardBody className="flex-row items-center gap-3.5 px-4 py-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-medium bg-primary/10 text-primary">
                <Icon name={card.icon} className="h-5 w-5" />
              </span>
              <div className="min-w-0 text-left">
                <span className="block text-tiny text-default-500">
                  {card.label}
                </span>
                <strong className="block text-2xl font-semibold leading-tight tracking-tight">
                  {counts[card.key] ?? 0}
                </strong>
                <span className="block truncate text-tiny text-default-400">
                  {card.detail}
                </span>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(300px,0.85fr)]">
        <div className="flex flex-col gap-4">
          <Card
            shadow="none"
            className="relative overflow-hidden border border-divider bg-content1"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-secondary/10 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-28 -left-20 h-64 w-64 rounded-full bg-primary/10 blur-3xl"
            />
            <CardBody className="relative gap-5 p-6">
              <div>
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.11em] text-primary">
                  Agent playground
                </span>
                <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                  What do you want your agent to do?
                </h2>
                <p className="mt-1 text-small text-default-500">
                  Choose an enabled agent and open a clean, persisted chat
                  session.
                </p>
              </div>

              {agents.length ? (
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                  <Select
                    aria-label="Agent to chat with"
                    variant="bordered"
                    radius="md"
                    className="sm:max-w-md"
                    classNames={{ trigger: "bg-content1" }}
                    selectedKeys={selectedAgent ? [selectedAgent] : []}
                    disabledKeys={agents
                      .filter((agent) => !agent.enabled)
                      .map((agent) => agent.id)}
                    onSelectionChange={(keys) =>
                      setSelectedAgent([...keys][0] ?? "")
                    }
                  >
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} textValue={agent.name}>
                        {agent.name}
                        {!agent.enabled ? " (disabled)" : ""}
                      </SelectItem>
                    ))}
                  </Select>
                  <Button
                    color="primary"
                    radius="md"
                    isDisabled={!selectedAgent}
                    onPress={() => navigate(`/chat/${selectedAgent}`)}
                    endContent={<Icon name="arrow" className="h-4 w-4" />}
                  >
                    Start chatting
                  </Button>
                </div>
              ) : (
                <p className="text-small text-default-500">
                  Create an agent after adding a model provider.
                </p>
              )}
            </CardBody>
          </Card>

          <SectionCard
            title="Recent runs"
            description="Latest AgentCore activity across this workspace."
            action={
              <HeroLink href="/runs" size="sm" className="shrink-0">
                View all
              </HeroLink>
            }
            bodyClassName="px-2 pb-2 pt-2"
          >
            <Table
              removeWrapper
              aria-label="Recent runs"
              classNames={{
                th: "bg-transparent text-[10px] uppercase tracking-wider text-default-500",
                td: "text-small",
              }}
            >
              <TableHeader>
                <TableColumn>Agent</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Tokens</TableColumn>
                <TableColumn>Duration</TableColumn>
                <TableColumn>When</TableColumn>
                <TableColumn hideHeader>Open</TableColumn>
              </TableHeader>
              <TableBody emptyContent="No runs yet.">
                {recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">
                      {run.agentName}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={run.status} />
                    </TableCell>
                    <TableCell className="text-default-500">
                      {tokens(run.usage)}
                    </TableCell>
                    <TableCell className="text-default-500">
                      {duration(run.durationMs)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-default-500">
                      {when(run.createdAt)}
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
        </div>

        <aside className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1">
          <SectionCard title="Setup" description="The shortest path to a first answer.">
            <ol className="flex flex-col gap-2">
              <SetupStep
                complete={(counts.modelProviders ?? 0) > 0}
                label="Connect a model"
                to="/model-providers/new"
              />
              <SetupStep
                complete={(counts.agents ?? 0) > 0}
                label="Create an agent"
                to="/agents/new"
              />
              <SetupStep
                complete={(counts.chats ?? 0) > 0}
                label="Start a chat"
                to="/chat"
              />
            </ol>
          </SectionCard>

          <SectionCard
            title="Recent chats"
            description="Jump back into a saved thread."
            action={
              <HeroLink href="/chat" size="sm" className="shrink-0">
                All chats
              </HeroLink>
            }
            bodyClassName="px-2 py-2"
          >
            {recentChats.length ? (
              <ul className="flex flex-col">
                {recentChats.slice(0, 5).map((chat) => (
                  <li key={chat.id}>
                    <HeroLink
                      href={`/chat/${chat.agentId}?chat=${chat.id}`}
                      className="block rounded-medium px-3 py-2 text-foreground transition-colors hover:bg-default-100"
                    >
                      <span className="block truncate text-small font-medium">
                        {chat.title || chat.agentName}
                      </span>
                      <span className="mt-0.5 block truncate text-tiny text-default-500">
                        {chat.agentName} · {relative(chat.updatedAt)}
                      </span>
                    </HeroLink>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-small text-default-500">
                No saved chats yet.
              </p>
            )}
          </SectionCard>
        </aside>
      </div>
    </section>
  );
}

function SetupStep({ complete, label, to }) {
  return (
    <li>
      <HeroLink
        href={to}
        className={`flex w-full items-center gap-2.5 rounded-medium border px-3 py-2.5 text-small transition-colors ${
          complete
            ? "border-success/30 bg-success/5 text-foreground"
            : "border-divider bg-content2 text-foreground hover:border-primary/40"
        }`}
      >
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] ${
            complete
              ? "border-success/40 bg-success/10 text-success"
              : "border-divider text-default-400"
          }`}
        >
          {complete ? <Icon name="check" className="h-3 w-3" /> : "•"}
        </span>
        {label}
        <Icon name="arrow" className="ml-auto h-4 w-4 text-default-400" />
      </HeroLink>
    </li>
  );
}

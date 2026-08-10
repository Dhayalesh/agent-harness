import {
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Link as HeroLink,
} from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import {
  AgentAvatar,
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

export function AgentsPage() {
  const [agents, setAgents] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

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
      await load(query);
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Build"
        title="Agents"
        description="Compose a model provider, local tools, MCP servers, and skills into a runnable definition."
        actions={
          <>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              label="Search agents"
              placeholder="Search agents"
            />
            <Button
              as={Link}
              color="primary"
              radius="md"
              to="/agents/new"
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New agent
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      {agents === null ? (
        <Loading what="agents" />
      ) : agents.length === 0 ? (
        <EmptyState
          icon="agents"
          title="No agents found"
          description={
            query
              ? "Try a different search."
              : "Create an agent after connecting a model provider."
          }
          action={
            !query && (
              <Button as={Link} color="primary" radius="md" to="/agents/new">
                Create agent
              </Button>
            )
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {agents.map((agent) => {
            const provider = agent.resolved?.modelProvider;
            const issues = agent.resolved?.issues ?? [];
            return (
              <li key={agent.id} className="min-w-0">
                <Card
                  shadow="none"
                  className="h-full border border-divider bg-content1 transition-colors hover:border-primary/30"
                >
                  <CardHeader className="flex items-start justify-between gap-3 px-5 pb-0 pt-5">
                    <div className="flex min-w-0 items-center gap-3">
                      <AgentAvatar name={agent.name} />
                      <div className="min-w-0">
                        <HeroLink
                          href={`/agents/${agent.id}`}
                          className="block truncate text-medium font-semibold text-foreground"
                        >
                          {agent.name}
                        </HeroLink>
                        <span className="block truncate text-tiny text-default-500">
                          {provider?.name ?? "No model provider"}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      {agent.stream && <StatusPill status="streaming" />}
                      {agent.isDefault && <StatusPill status="default" />}
                      <StatusPill
                        status={agent.enabled ? "enabled" : "disabled"}
                      />
                    </div>
                  </CardHeader>

                  <CardBody className="gap-4 px-5 py-4">
                    <p className="line-clamp-2 min-h-[2.6em] text-small text-default-500">
                      {agent.description || "No description."}
                    </p>

                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Fact label="Model" value={agent.model ?? provider?.model ?? "—"} />
                      <Fact label="Tools" value={agent.tools?.length ?? 0} />
                      <Fact label="MCP" value={agent.mcpServerIds?.length ?? 0} />
                      <Fact label="Skills" value={agent.skills?.length ?? 0} />
                      <Fact
                        label="Updated"
                        value={when(agent.updatedAt ?? agent.createdAt)}
                        className="col-span-2 sm:col-span-1"
                      />
                    </dl>

                    {agent.resolved?.ready === false && (
                      <Chip
                        size="sm"
                        variant="flat"
                        color="warning"
                        classNames={{
                          base: "h-auto max-w-full py-1",
                          content: "whitespace-normal text-tiny",
                        }}
                        startContent={
                          <Icon name="alert" className="ml-1 h-3.5 w-3.5" />
                        }
                      >
                        {issues[0]?.message ??
                          issues[0] ??
                          "Configuration needs attention."}
                      </Chip>
                    )}
                  </CardBody>

                  <Divider />
                  <CardFooter className="gap-1 px-3 py-2">
                    <Button
                      as={Link}
                      size="sm"
                      variant="light"
                      to={`/chat/${agent.id}`}
                      startContent={<Icon name="chat" className="h-4 w-4" />}
                    >
                      Chat
                    </Button>
                    <Button
                      as={Link}
                      size="sm"
                      variant="light"
                      to={`/agents/${agent.id}`}
                    >
                      Open
                    </Button>
                    <Button
                      as={Link}
                      size="sm"
                      variant="light"
                      to={`/agents/${agent.id}/edit`}
                    >
                      Edit
                    </Button>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      color="danger"
                      className="ml-auto"
                      aria-label={`Delete ${agent.name}`}
                      onPress={() => remove(agent)}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {confirmDialog}
    </section>
  );
}

function Fact({ label, value, className = "" }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.06em] text-default-500">
        {label}
      </dt>
      <dd className="truncate text-small text-foreground">{value}</dd>
    </div>
  );
}

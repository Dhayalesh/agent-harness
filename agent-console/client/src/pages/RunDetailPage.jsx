import {
  Alert,
  Button,
  Code,
  ScrollShadow,
  Snippet,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  MetaGrid,
  PageHeader,
  SectionCard,
  StatTile,
  StatusPill,
  duration,
  tokens,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";

export function RunDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    void api
      .getRun(id)
      .then(({ run: found }) => setRun(found))
      .catch(setError);
  }, [id]);

  if (!run) return error ? <ErrorNote error={error} /> : <Loading what="run" />;

  const remove = async () => {
    const confirmed = await confirm({
      title: "Delete run record",
      body: "Delete this run record? The prompt, output, and usage stored on it are removed.",
      confirmLabel: "Delete run",
    });
    if (!confirmed) return;
    try {
      await api.deleteRun(id);
      navigate("/runs");
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow="Observe"
        title={
          <span className="flex items-center gap-3">
            Run
            <StatusPill status={run.status} size="md" />
          </span>
        }
        description={`${run.agentName} · ${when(run.createdAt)}`}
        actions={
          <>
            <Button
              variant="bordered"
              radius="md"
              href={`/agents/${run.agentId}`}
              startContent={<Icon name="agents" className="h-4 w-4" />}
            >
              Open agent
            </Button>
            <Button
              variant="light"
              color="danger"
              radius="md"
              onPress={remove}
              startContent={<Icon name="trash" className="h-4 w-4" />}
            >
              Delete
            </Button>
          </>
        }
      />

      <ErrorNote error={error} />

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Turns" value={run.turns ?? "—"} />
        <StatTile label="Tokens" value={tokens(run.usage)} />
        <StatTile label="Duration" value={duration(run.durationMs)} />
        <StatTile label="Stop reason" value={run.stopReason ?? "—"} />
      </div>

      {run.error && (
        <Alert
          color="warning"
          variant="flat"
          title={run.error.code}
          classNames={{
            base: "mb-4 items-start border border-warning-200 dark:border-warning-500/25",
            title: "text-small font-semibold",
          }}
        >
          <p className="text-tiny">
            {run.error.message}
            {run.error.recoverable ? " (recoverable)" : ""}
          </p>
        </Alert>
      )}

      <div className="mb-4 grid grid-cols-1 gap-4">
        <SectionCard
          title="AgentCore metadata"
          description="What identified this invocation at the runtime."
        >
          <MetaGrid
            wide
            items={[
              {
                label: "Runtime session id",
                // Reused for AgentCore affinity and the same runtime workspace.
                value: <CopyableId value={run.runtimeSessionId} />,
              },
              { label: "Trace id", value: <CopyableId value={run.traceId} /> },
              {
                label: "Runtime",
                value: <CopyableId value={run.agentRuntimeArn} />,
              },
              {
                label: "Qualifier",
                value: run.agentRuntimeQualifier ?? "—",
              },
              {
                label: "Workspace",
                value: <CopyableId value={run.workingDirectory} />,
              },
            ]}
          />
        </SectionCard>

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <SectionCard title="Prompt" bodyClassName="px-5 pb-5 pt-1">
            <ScrollShadow className="max-h-[260px] rounded-medium border border-divider bg-content2">
              <pre className="message-text p-3.5 font-mono text-tiny">
                {run.prompt}
              </pre>
            </ScrollShadow>
          </SectionCard>

          <SectionCard title="Output" bodyClassName="px-5 pb-5 pt-1">
            <ScrollShadow className="max-h-[260px] rounded-medium border border-divider bg-content2">
              <pre className="message-text p-3.5 font-mono text-tiny">
                {run.output || "(no text output)"}
              </pre>
            </ScrollShadow>
          </SectionCard>
        </div>

        <SectionCard
          title="Tool usage"
          description="Calls the runtime made during this turn."
          bodyClassName="px-2 pb-2 pt-2"
        >
          <Table
            removeWrapper
            aria-label="Tool usage"
            classNames={{
              th: "bg-transparent text-[10px] uppercase tracking-wider text-default-500",
              td: "text-small",
            }}
          >
            <TableHeader>
              <TableColumn>Tool</TableColumn>
              <TableColumn>Calls</TableColumn>
              <TableColumn>Errors</TableColumn>
            </TableHeader>
            <TableBody emptyContent="No tools were called.">
              {(run.tools ?? []).map((tool) => (
                <TableRow key={tool.name}>
                  <TableCell>
                    <Code size="sm" className="text-tiny">
                      {tool.name}
                    </Code>
                  </TableCell>
                  <TableCell className="text-default-500">
                    {tool.calls}
                  </TableCell>
                  <TableCell
                    className={tool.errors ? "text-danger" : "text-default-500"}
                  >
                    {tool.errors}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard
          title="Token detail"
          description="The usage record exactly as it was stored."
          bodyClassName="px-5 pb-5 pt-1"
        >
          <ScrollShadow className="max-h-[340px] rounded-medium border border-divider bg-content2">
            <pre className="code-scroll text-default-500">
              {JSON.stringify(run.usage ?? {}, null, 2)}
            </pre>
          </ScrollShadow>
        </SectionCard>
      </div>

      {confirmDialog}
    </section>
  );
}

/** Identifiers here are long and get pasted into AWS consoles, so make copying cheap. */
function CopyableId({ value }) {
  if (!value) return "—";
  return (
    <Snippet
      size="sm"
      variant="flat"
      hideSymbol
      tooltipProps={{ content: "Copy" }}
      classNames={{
        base: "max-w-full gap-1 bg-content2 px-2 py-1",
        pre: "truncate text-tiny",
      }}
    >
      {value}
    </Snippet>
  );
}

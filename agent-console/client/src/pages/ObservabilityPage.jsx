import {
  Card,
  Link as HeroLink,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Tooltip,
} from "@heroui/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  PageHeader,
  StatusPill,
  duration,
  tokens,
  when,
} from "../components/Bits.jsx";

// "all" rather than "" because an empty string is not a usable collection key.
const statusOptions = [
  { key: "all", label: "All statuses" },
  { key: "success", label: "Success" },
  { key: "error", label: "Error" },
];

/**
 * Every trace is a `Run` — one user prompt, one invocation (see
 * docs/observability-platform-plan.md §2). This list is deliberately close to
 * RunsPage: it reuses the same data, just framed as the entry point into the
 * waterfall view (TraceDetailPage) rather than the raw invocation record.
 */
export function ObservabilityPage() {
  const [runs, setRuns] = useState(null);
  const [status, setStatus] = useState("all");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { runs: found } = await api.listRuns({
        status: status === "all" ? undefined : status,
        limit: 100,
      });
      setRuns(found);
    } catch (caught) {
      setError(caught);
      setRuns([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <PageHeader
        eyebrow="Observe"
        title="Observability"
        description="Every agent invocation as a trace — model calls and tool calls, with timing, tokens, and cost. Open one to see its waterfall."
        actions={
          <Select
            aria-label="Filter by status"
            size="sm"
            radius="md"
            variant="bordered"
            className="w-[190px]"
            classNames={{ trigger: "h-9 bg-content1" }}
            selectedKeys={[status]}
            onSelectionChange={(keys) => setStatus([...keys][0] ?? "all")}
          >
            {statusOptions.map((option) => (
              <SelectItem key={option.key}>{option.label}</SelectItem>
            ))}
          </Select>
        }
      />

      <ErrorNote error={error} />

      {runs === null ? (
        <Loading what="traces" />
      ) : (
        <Card shadow="none" className="border border-divider bg-content1 p-2">
          <Table
            removeWrapper
            aria-label="Traces"
            classNames={{
              th: "bg-transparent text-[10px] uppercase tracking-wider text-default-500",
              td: "text-small",
            }}
          >
            <TableHeader>
              <TableColumn>When</TableColumn>
              <TableColumn>Agent</TableColumn>
              <TableColumn>Prompt</TableColumn>
              <TableColumn>Status</TableColumn>
              <TableColumn>Tokens</TableColumn>
              <TableColumn>Duration</TableColumn>
              <TableColumn hideHeader>Open</TableColumn>
            </TableHeader>
            <TableBody emptyContent="No traces recorded yet.">
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="whitespace-nowrap text-default-500">
                    {when(run.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium">{run.agentName}</TableCell>
                  <TableCell className="max-w-[320px]">
                    <Tooltip
                      content={run.prompt}
                      placement="top-start"
                      delay={400}
                      classNames={{ content: "max-w-sm" }}
                    >
                      <span className="block truncate text-default-500">
                        {run.prompt}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <StatusPill status={run.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-default-500">
                    {tokens(run.usage)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-default-500">
                    {duration(run.durationMs)}
                  </TableCell>
                  <TableCell>
                    <HeroLink href={`/observability/${run.id}`} size="sm">
                      Open trace
                    </HeroLink>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}

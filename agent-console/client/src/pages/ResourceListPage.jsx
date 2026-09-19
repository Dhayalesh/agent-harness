import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  EmptyState,
  ErrorNote,
  relative,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Icon } from "../components/Icon.jsx";
import { PageShell } from "../components/PageShell.jsx";
import { useToast } from "../components/Toast.jsx";
import {
  Toolbar,
  ToolbarSearch,
  ToolbarSpacer,
} from "../components/Toolbar.jsx";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Model providers, MCP servers, skills and templates are four different records
 * that behave identically: list them, search them, edit one, delete one with a
 * confirmation. They were four near-identical 200-line pages, which is four places
 * for the interaction to drift — and it had, with only some of them filtering
 * locally and none of them confirming that a delete succeeded.
 *
 * The behaviour lives here once. Each page now declares only what is genuinely
 * different: its copy, its columns, and the two API calls.
 *
 * @param load    (query) => Promise<row[]> resolves the collection
 * @param remove  (row)   => Promise<void> deletes one record
 * @param search  (row)   => string[] fields the local filter looks at
 */
export function ResourceListPage({
  breadcrumbs,
  title,
  description,
  newHref,
  newLabel,
  singular,
  plural,
  emptyIcon,
  emptyDescription,
  editHref,
  columns,
  defaultSort = { key: "updatedAt", dir: "desc" },
  load,
  remove,
  search,
  searchPlaceholder,
}) {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { toast } = useToast();

  const fetchRows = useCallback(
    async (q) => {
      setError(null);
      try {
        setRows((await load(q)) ?? []);
      } catch (caught) {
        setError(caught);
        setRows([]);
      }
    },
    [load],
  );

  // Debounced so typing does not fire a request per keystroke, but the first
  // load is immediate because there is nothing to debounce yet.
  useEffect(() => {
    const timer = setTimeout(() => void fetchRows(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, fetchRows]);

  /**
   * The API may implement `q` server-side; filtering again keeps search working
   * against older console servers that return the whole collection regardless.
   */
  const visible = useMemo(() => {
    if (!rows || !query.trim()) return rows;
    const needle = query.trim().toLowerCase();
    return rows.filter((row) =>
      search(row)
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [rows, query, search]);

  const onDelete = async (row) => {
    const confirmed = await confirm({
      title: `Delete ${singular}`,
      body: `Delete "${row.name}"? Agents that reference it must be updated first.`,
      confirmLabel: `Delete ${singular}`,
    });
    if (!confirmed) return;
    try {
      await remove(row);
      toast({ title: `Deleted ${singular}`, description: row.name });
      await fetchRows(query);
    } catch (caught) {
      setError(caught);
      toast({
        title: `Could not delete ${singular}`,
        description: caught.message,
        tone: "danger",
      });
    }
  };

  return (
    <PageShell
      breadcrumbs={breadcrumbs}
      title={title}
      description={description}
      actions={
        <Button asChild className="font-semibold">
          <Link to={newHref}>
            <Icon name="plus" className="h-4 w-4" />
            {newLabel}
          </Link>
        </Button>
      }
    >
      <ErrorNote error={error} />

      <Toolbar>
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          label={`Search ${plural}`}
          placeholder={searchPlaceholder ?? `Search ${plural}`}
        />
        <ToolbarSpacer />
      </Toolbar>

      <DataTable
        caption={title}
        columns={columns}
        rows={visible}
        loading={rows === null}
        to={editHref}
        defaultSort={defaultSort}
        total={rows?.length}
        totalLabel={plural}
        actions={(row) => [
          {
            key: "edit",
            label: `Edit ${row.name}`,
            icon: "edit",
            to: editHref(row),
          },
          {
            key: "delete",
            label: `Delete ${row.name}`,
            icon: "trash",
            tone: "danger",
            onClick: () => onDelete(row),
          },
        ]}
        empty={
          <EmptyState
            icon={emptyIcon}
            title={
              query ? `No ${plural} match this search` : `No ${plural} yet`
            }
            description={
              query ? "Try a different search term." : emptyDescription
            }
            action={
              !query && (
                <Button asChild>
                  <Link to={newHref}>{newLabel}</Link>
                </Button>
              )
            }
          />
        }
      />

      {confirmDialog}
    </PageShell>
  );
}

/**
 * The "Updated"column, identical on every resource list. Declared once so the four
 * pages cannot disagree about how a timestamp is formatted or sorted.
 */
export function updatedColumn() {
  return {
    key: "updatedAt",
    header: "Updated",
    sortable: true,
    sortType: "date",
    align: "right",
    width: "112px",
    hideBelow: "sm",
    value: (row) => row.updatedAt ?? row.createdAt,
    render: (row) => (
      <Tooltip
        delayDuration={300}
        content={when(row.updatedAt ?? row.createdAt)}
      >
        <span className="whitespace-nowrap text-default-500">
          {relative(row.updatedAt ?? row.createdAt)}
        </span>
      </Tooltip>
    ),
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { Icon } from "./Icon.jsx";
import { useTheme } from "../theme.jsx";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * Ctrl/Cmd-K: go anywhere, do anything, without leaving the keyboard.
 *
 * A console with a dozen routes and an unbounded list of agents is faster to drive
 * by name than by pointer, and the palette is where an operator expects to find
 * that. Agents are fetched once when the palette first opens and cached for the
 * session, so typing stays instant and closing the palette does not throw the list
 * away.
 *
 * The matching, keyboard navigation and active-row scrolling all belong to cmdk —
 * the library shadcn's Command is built on. It already scores subsequences, so
 * "mcps" finds "MCP Servers" the way every palette users know behaves, and there is
 * no hand-written scorer here to disagree with it.
 */

const STATIC_COMMANDS = [
  {
    id: "nav-dashboard",
    group: "Go to",
    label: "Dashboard",
    icon: "dashboard",
    to: "/",
  },
  { id: "nav-chat", group: "Go to", label: "Chat", icon: "chat", to: "/chat" },
  {
    id: "nav-agents",
    group: "Go to",
    label: "Agents",
    icon: "agents",
    to: "/agents",
  },
  {
    id: "nav-models",
    group: "Go to",
    label: "Model providers",
    icon: "models",
    to: "/model-providers",
  },
  {
    id: "nav-mcp",
    group: "Go to",
    label: "MCP servers",
    icon: "plug",
    to: "/mcp-servers",
  },
  {
    id: "nav-skills",
    group: "Go to",
    label: "Skills",
    icon: "skills",
    to: "/skills",
  },
  {
    id: "nav-templates",
    group: "Go to",
    label: "Templates",
    icon: "document",
    to: "/templates",
  },
  { id: "nav-runs", group: "Go to", label: "Runs", icon: "runs", to: "/runs" },

  {
    id: "new-agent",
    group: "Create",
    label: "New agent",
    icon: "plus",
    to: "/agents/new",
  },
  {
    id: "new-model",
    group: "Create",
    label: "New model provider",
    icon: "plus",
    to: "/model-providers/new",
  },
  {
    id: "new-mcp",
    group: "Create",
    label: "New MCP server",
    icon: "plus",
    to: "/mcp-servers/new",
  },
  {
    id: "new-skill",
    group: "Create",
    label: "New skill",
    icon: "plus",
    to: "/skills/new",
  },
  {
    id: "new-template",
    group: "Create",
    label: "New template",
    icon: "plus",
    to: "/templates/new",
  },
];

export function CommandPalette({ open, onOpenChange }) {
  const navigate = useNavigate();
  const { isDark, toggleTheme } = useTheme();
  const [agents, setAgents] = useState([]);

  // Fetched on first open only: the palette should not cost a request per keystroke.
  useEffect(() => {
    if (!open || agents.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listAgents({});
        if (!cancelled) setAgents(result.agents ?? []);
      } catch {
        // A palette without agents still navigates; failing quietly is correct.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, agents.length]);

  const commands = useMemo(() => {
    const agentCommands = agents.flatMap((agent) => [
      {
        id: `chat-${agent.id}`,
        group: "Chat with",
        label: agent.name,
        hint: agent.model ?? agent.resolved?.modelProvider?.name,
        icon: "chat",
        to: `/chat/${agent.id}`,
      },
      {
        id: `open-${agent.id}`,
        group: "Open agent",
        label: agent.name,
        hint: "View definition",
        icon: "agents",
        to: `/agents/${agent.id}`,
      },
    ]);

    return [
      ...STATIC_COMMANDS,
      ...agentCommands,
      {
        id: "toggle-theme",
        group: "Preferences",
        label: isDark ? "Switch to light theme" : "Switch to dark theme",
        icon: isDark ? "sun" : "moon",
        run: toggleTheme,
      },
    ];
  }, [agents, isDark, toggleTheme]);

  /**
   * Grouped in declaration order. A Map preserves insertion order, so "Go to"
   * stays above "Create" without carrying a sort index on every command.
   */
  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const command of commands) {
      if (!byGroup.has(command.group)) byGroup.set(command.group, []);
      byGroup.get(command.group).push(command);
    }
    return [...byGroup];
  }, [commands]);

  const choose = useCallback(
    (command) => {
      if (!command) return;
      onOpenChange(false);
      if (command.run) command.run();
      else if (command.to) navigate(command.to);
    },
    [navigate, onOpenChange],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search workspace"
      description="Find pages, agents, and actions in your workspace."
    >
      <CommandInput aria-label="Search workspace" placeholder="Search pages, agents, or actions…" />
      <CommandList>
        <CommandEmpty>
          <span className="mx-auto mb-4 grid size-12 place-items-center rounded-xl border border-divider bg-content2">
            <Icon name="search" className="size-5" />
          </span>
          <strong className="block text-large font-semibold text-foreground">No results found</strong>
          <span className="mt-2 block text-small leading-6">Try a page name, an agent, or an action such as “create”.</span>
        </CommandEmpty>
        {groups.map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((command) => (
              <CommandItem
                key={command.id}
                /* Stable IDs distinguish agents with the same name; keywords retain label, group, and model matching. */
                value={command.id}
                keywords={[command.label, command.group, command.hint].filter(Boolean)}
                onSelect={() => choose(command)}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-divider bg-content2/60 text-default-500 transition-colors group-data-[selected=true]:border-primary/15 group-data-[selected=true]:bg-primary/[0.08] group-data-[selected=true]:text-primary">
                  <Icon name={command.icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium text-foreground">{command.label}</span>
                  {command.hint && (
                    <span className="mt-0.5 block truncate text-tiny text-default-500">{command.hint}</span>
                  )}
                </span>
                <Icon name="arrow" className="size-4 text-primary opacity-0 transition-opacity group-data-[selected=true]:opacity-100" />
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>

      <div className="flex shrink-0 items-center gap-4 border-t border-divider bg-content2/60 px-5 py-3">
        <span className="flex items-center gap-1.5 text-tiny text-default-500">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1.5 text-tiny text-default-500">
          <Kbd>↵</Kbd> select
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-tiny text-default-500">
          <Kbd>Esc</Kbd> close
        </span>
      </div>
    </CommandDialog>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-divider bg-content1 px-1 py-0.5 text-micro font-medium text-default-600 shadow-sm">
      {children}
    </kbd>
  );
}

/**
 * Owns the global shortcut so a single listener serves the whole app. Returns the
 * open state plus a setter for the visible trigger in the shell.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!event.repeat && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return [open, setOpen];
}

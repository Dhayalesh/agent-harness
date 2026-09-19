import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useMatch } from "react-router-dom";
import { useTheme } from "../theme.jsx";
import { APP_TAGLINE, BrandLockup, BrandMark } from "./Brand.jsx";
import { CommandPalette, useCommandPalette } from "./CommandPalette.jsx";
import { HealthBanner } from "./HealthBanner.jsx";
import { Icon } from "./Icon.jsx";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Navigation is grouped by what an operator is doing, not by the shape of the
 * records: look at the workspace, configure what runs, then inspect what ran.
 */
const navigation = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard", end: true },
      { to: "/chat", label: "Chat", icon: "chat" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/agents", label: "Agents", icon: "agents" },
      { to: "/model-providers", label: "Models", icon: "models" },
      { to: "/mcp-servers", label: "MCP Servers", icon: "plug" },
      { to: "/skills", label: "Skills", icon: "skills" },
      { to: "/templates", label: "Templates", icon: "document" },
    ],
  },
  {
    label: "Operations",
    items: [{ to: "/runs", label: "Runs", icon: "runs" }],
  },
];

/**
 * The rail state is a workspace preference, not a session detail: an operator who
 * collapsed the navigation to gain screen width expects it to stay collapsed.
 */
const RAIL_KEY = "enterprise-agents:nav-collapsed";

function readCollapsed() {
  try {
    return window.localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useCommandPalette();
  const location = useLocation();
  const isChat = location.pathname.startsWith("/chat");

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
    } catch {
      // A preference that cannot persist still applies for this session.
    }
  }, [collapsed]);

  // The rail only exists on desktop; the mobile drawer is always full width.
  const railWidth = collapsed ? "lg:w-[64px]" : "lg:w-[252px]";

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside
        className={cn(
          isChat ? "hidden" : "fixed flex lg:static",
          "inset-y-0 left-0 z-40 w-[264px] shrink-0 flex-col border-r border-divider bg-content1 transition-[transform,width] duration-200 lg:translate-x-0",
          railWidth,
          menuOpen ? "translate-x-0 shadow-overlay" : "-translate-x-full",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-divider px-4",
            collapsed && "lg:justify-center lg:px-0",
          )}
        >
          {collapsed ? (
            <>
              <span className="lg:hidden">
                <BrandLockup subtitle={APP_TAGLINE} />
              </span>
              <span className="hidden lg:block">
                <BrandMark className="h-8 w-8" />
              </span>
            </>
          ) : (
            <BrandLockup subtitle={APP_TAGLINE} />
          )}
        </div>

        {/*
          Search sits above the navigation because it supersedes it: once a
          workspace has more agents than fit in a list, naming the thing you want
          is faster than finding it. The shortcut is printed on the control so it
          is learnable rather than folklore.
        */}
        <div className={cn("shrink-0 px-3 pt-3", collapsed && "lg:px-2")}>
          {/* Only worth a tooltip once the label is hidden by the rail. */}
          <Tooltip
            content={collapsed ? "Search (Ctrl + K)" : null}
            side="right"
          >
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search workspace"
              aria-keyshortcuts="Control+k Meta+k"
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              className={cn(
                "flex h-10 w-full items-center gap-2.5 rounded-lg border border-divider bg-content2/60 text-default-500 transition-colors hover:border-primary/25 hover:bg-primary/[0.04] hover:text-foreground",
                "px-2.5",
                collapsed && "lg:mx-auto lg:w-10 lg:justify-center lg:gap-0 lg:px-0",
              )}
            >
              <Icon name="search" className="h-4 w-4 shrink-0" />
              <span className={cn("label", collapsed && "lg:hidden")}>
                Search
              </span>
              <kbd
                className={cn(
                  "ml-auto shrink-0 rounded border border-divider bg-content1 px-1.5 py-0.5 text-micro font-medium text-default-500 shadow-sm",
                  collapsed && "lg:hidden",
                )}
              >
                Ctrl + K
              </kbd>
            </button>
          </Tooltip>
        </div>

        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName={cn("px-3 py-3", collapsed && "lg:px-2")}
        >
          <nav className="flex flex-col gap-5" aria-label="Main navigation">
            {navigation.map((group) => (
              <div className="flex flex-col gap-0.5" key={group.label}>
                {/*
                  A rail has no room for a group heading, but the grouping still
                  carries meaning, so it degrades to a rule rather than vanishing.
                */}
                <span
                  className={cn(
                    "label rule-heading px-2.5 pb-2.5 pt-1",
                    collapsed && "lg:hidden",
                  )}
                >
                  {group.label}
                </span>
                {collapsed && (
                  <Separator className="mx-auto mb-1.5 hidden w-5 lg:block" />
                )}

                {group.items.map((item) => (
                  <NavigationItem key={item.to} item={item} collapsed={collapsed} />
                ))}
              </div>
            ))}
          </nav>
        </ScrollArea>

        <Separator />
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 px-3 py-2.5",
            collapsed && "lg:flex-col lg:px-2 lg:[&>button]:size-10",
          )}
        >
          <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
            <span className="label block truncate">AgentCore</span>
            <span className="mt-1.5 flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-[5px] w-[5px] shrink-0 bg-success"
              />
              <span className="truncate text-tiny text-default-500">
                Control plane
              </span>
            </span>
          </div>
          <ThemeToggle />
          <RailToggle
            collapsed={collapsed}
            onToggle={() => setCollapsed((c) => !c)}
          />
        </div>
      </aside>

      {menuOpen && !isChat && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-scrim/45 backdrop-blur-sm lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/*
          Mobile only. On desktop the sidebar carries search and preferences, and
          each page renders its own breadcrumb through PageShell, so a second
          global bar would be 56px of duplicated chrome.
        */}
        <header
          className={cn(
            isChat ? "hidden" : "flex",
            "h-14 shrink-0 items-center gap-2 border-b border-divider bg-content1 px-3 lg:hidden",
          )}
        >
          <IconButton
            label="Open navigation"
            icon="menu"
            onClick={() => setMenuOpen(true)}
            expanded={menuOpen}
          />
          <BrandMark className="h-7 w-7" />
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              label="Search"
              icon="search"
              onClick={() => setPaletteOpen(true)}
            />
            <ThemeToggle />
          </div>
        </header>

        <HealthBanner />

        {/*
          The padded wrapper is the scroller, not <main>. It gives it a definite
          height from `flex-1`, which is what a page like Chat needs to size itself
          to the viewport instead of growing with its transcript. A `min-h-full`
          wrapper cannot do that: its own height stays content-driven, so a tall
          page pushes everything below it — the chat composer included — off screen.
        */}
        <main id="main-content" className="flex min-h-0 flex-1 flex-col">
          <div
            className={
              isChat
                ? "flex w-full flex-1 flex-col overflow-hidden"
                : "mx-auto flex w-full max-w-[1440px] flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 lg:px-8"
            }
          >
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** The shell's 32px icon control: a ghost Button locked to the rail's square box. */
function IconButton({ label, icon, onClick, expanded }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
      className="text-default-500 hover:bg-content2 hover:text-foreground"
    >
      <Icon name={icon} className="h-[18px] w-[18px]" />
    </Button>
  );
}

function RailToggle({ collapsed, onToggle }) {
  const label = collapsed ? "Expand navigation" : "Collapse navigation";
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={collapsed}
        onClick={onToggle}
        className="hidden text-default-500 hover:bg-content2 hover:text-foreground lg:inline-flex"
      >
        <Icon name="panelLeft" className="h-[18px] w-[18px]" />
      </Button>
    </Tooltip>
  );
}

function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <Tooltip content={isDark ? "Switch to light" : "Switch to dark"}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        onClick={toggleTheme}
        className="text-default-500 hover:bg-content2 hover:text-foreground"
      >
        <Icon name={isDark ? "sun" : "moon"} className="h-[18px] w-[18px]" />
      </Button>
    </Tooltip>
  );
}

/** Resolve active state before Radix Slot receives the link's className. */
function NavigationItem({ item, collapsed }) {
  const active = Boolean(useMatch({ path: item.to, end: item.end ?? false }));
  return (
    <Tooltip content={collapsed ? item.label : null} side="right">
      <NavLink
        to={item.to}
        end={item.end}
        aria-label={item.label}
        className={cn(
          "group relative flex min-h-10 items-center gap-2.5 rounded-lg pl-3 pr-2.5 text-small transition-colors duration-200",
          collapsed && "lg:mx-auto lg:size-10 lg:justify-center lg:gap-0 lg:px-0",
          active
            ? "bg-primary/[0.08] font-semibold text-primary ring-1 ring-inset ring-primary/10 dark:bg-primary/[0.14]"
            : "font-medium text-default-600 hover:bg-primary/[0.05] hover:text-foreground",
        )}
      >
        <Icon name={item.icon} className="size-[18px] shrink-0" strokeWidth={active ? 2 : 1.7} />
        <span className={cn("truncate", collapsed && "lg:hidden")}>{item.label}</span>
      </NavLink>
    </Tooltip>
  );
}

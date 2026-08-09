import { Button, Chip, Divider, ScrollShadow, Tooltip } from "@heroui/react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTheme } from "../theme.jsx";
import { HealthBanner } from "./HealthBanner.jsx";
import { Icon } from "./Icon.jsx";

const navigation = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard", end: true },
      { to: "/chat", label: "Chat", icon: "chat" },
    ],
  },
  {
    label: "Build",
    items: [
      { to: "/agents", label: "Agents", icon: "agents" },
      { to: "/model-providers", label: "Models", icon: "models" },
      { to: "/mcp-servers", label: "MCP Servers", icon: "plug" },
      { to: "/skills", label: "Skills", icon: "skills" },
    ],
  },
  {
    label: "Observe",
    items: [
      { to: "/runs", label: "Runs", icon: "runs" },
      { to: "/observability", label: "Observability", icon: "waterfall" },
    ],
  },
];

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-divider bg-content1 transition-transform duration-200 lg:static lg:translate-x-0 ${
          menuOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
      >
        <BrandBlock />

        <ScrollShadow className="min-h-0 flex-1 px-3 pb-3" hideScrollBar>
          <nav className="flex flex-col gap-6" aria-label="Main navigation">
            {navigation.map((group) => (
              <div className="flex flex-col gap-1" key={group.label}>
                <span className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.11em] text-default-400">
                  {group.label}
                </span>
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      `flex min-h-10 items-center gap-3 rounded-medium border px-3 py-2 text-small font-medium transition-colors ${
                        isActive
                          ? "border-primary/25 bg-primary/10 text-primary"
                          : "border-transparent text-default-600 hover:bg-default-100 hover:text-foreground"
                      }`
                    }
                  >
                    <Icon name={item.icon} className="h-[18px] w-[18px]" />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </ScrollShadow>

        <Divider />
        <div className="flex items-center gap-2.5 px-4 py-3">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-success/50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-tiny font-semibold text-foreground">
              Control plane
            </strong>
            <span className="block truncate text-[10px] text-default-500">
              MongoDB + AgentCore
            </span>
          </div>
          <ThemeToggle />
        </div>
      </aside>

      {menuOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-divider bg-content1 px-4 lg:hidden">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onPress={() => setMenuOpen(true)}
          >
            <Icon name="menu" className="h-5 w-5" />
          </Button>
          <BrandMark className="h-6 w-6 rounded-[7px]" />
          <strong className="text-small font-semibold">Agent Console</strong>
          <div className="ml-auto">
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
          <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function BrandBlock() {
  return (
    <div className="flex items-center gap-3 px-5 pb-5 pt-5">
      <BrandMark />
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-small font-semibold text-foreground">
          Agent Console
        </strong>
        <span className="block truncate text-[11px] text-default-500">
          AgentCore workspace
        </span>
      </div>
      <Chip
        size="sm"
        variant="flat"
        color="primary"
        classNames={{
          base: "h-5 rounded-full",
          content: "px-1.5 text-[10px] font-semibold uppercase tracking-wider",
        }}
      >
        beta
      </Chip>
    </div>
  );
}

function BrandMark({ className = "h-8 w-8 rounded-medium" }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center bg-gradient-to-br from-primary to-secondary text-white ${className}`}
    >
      <Icon name="spark" className="h-[18px] w-[18px]" strokeWidth={1.6} />
    </span>
  );
}

function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <Tooltip
      content={isDark ? "Switch to light" : "Switch to dark"}
      placement="top"
      size="sm"
    >
      <Button
        isIconOnly
        size="sm"
        radius="full"
        variant="light"
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        onPress={toggleTheme}
      >
        <Icon name={isDark ? "sun" : "moon"} className="h-4 w-4" />
      </Button>
    </Tooltip>
  );
}

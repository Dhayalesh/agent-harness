import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { HealthBanner } from "./HealthBanner.jsx";

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
    items: [{ to: "/runs", label: "Runs", icon: "runs" }],
  },
];

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside className={menuOpen ? "sidebar sidebar-open" : "sidebar"}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong>Agent Console</strong>
            <span>AgentCore workspace</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-label">{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    isActive ? "nav-item nav-item-active" : "nav-item"
                  }
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Control plane</strong>
            <span>MongoDB + AgentCore</span>
          </div>
        </div>
      </aside>

      {menuOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="workspace-main">
        <header className="mobile-topbar">
          <button
            type="button"
            className="menu-button"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
          <div className="mobile-brand">
            <span className="brand-mark" aria-hidden="true" />
            <strong>Agent Console</strong>
          </div>
        </header>

        <HealthBanner />
        <main id="main-content" className="workspace-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function NavIcon({ name }) {
  const paths = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    chat: (
      <>
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
        <path d="M8 9h8M8 13h5" />
      </>
    ),
    agents: (
      <>
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M9 3h6M12 3v4M8 12h.01M16 12h.01M9 16h6" />
      </>
    ),
    models: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </>
    ),
    plug: (
      <>
        <path d="M8 12h8M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5v5" />
      </>
    ),
    skills: (
      <>
        <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z" />
        <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z" />
      </>
    ),
    runs: (
      <>
        <path d="M3 12h4l2-6 4 12 2-6h6" />
        <path d="M21 6v12" />
      </>
    ),
  };

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

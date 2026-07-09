// ══════════════════════════════════════════════════════════════════════
// App.tsx — Shell layout: header nav + <Outlet /> for child routes
// ══════════════════════════════════════════════════════════════════════

import { NavLink, Outlet } from "react-router-dom";
import { usePipelineStatus } from "./api/api";
import { useHumanStatus } from "./hooks/useHumanStatus";
import { humanLabelToUIStatus } from "./lib/human-status";
import { StatusBadge } from "./components/StatusBadge";
import { Breadcrumb } from "./components/Breadcrumb";

const NAV_ITEMS = [
  { to: "/", label: "Command Center", end: true },
  { to: "/pipeline", label: "Pipeline Flow" },
  { to: "/leaderboard", label: "Leaderboard" },
];

export default function App() {
  const { data: status } = usePipelineStatus();
  const humanStatus = useHumanStatus();

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            Formiga
          </h1>
          <nav className="flex gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-[var(--accent-blue)] text-white"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        {status?.runId && humanStatus && (
          <div className="flex items-center gap-3 text-sm">
            <NavLink
              to="/"
              className="text-[var(--text-primary)] bg-[var(--bg-tertiary)] hover:bg-[var(--accent-blue)] hover:text-white px-1.5 py-0.5 rounded text-xs font-mono transition-colors"
            >
              {status.runId.slice(0, 8)}
            </NavLink>
            <StatusBadge status={humanLabelToUIStatus(humanStatus.label)} size="sm" />
            <span className="text-[var(--text-muted)]">
              {humanStatus.description}
            </span>
          </div>
        )}
      </header>

      {/* Content area */}
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-screen-2xl mx-auto">
          <Breadcrumb />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
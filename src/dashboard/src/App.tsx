// ══════════════════════════════════════════════════════════════════════
// App.tsx — Shell layout: sidebar + <Outlet /> for child routes
// ══════════════════════════════════════════════════════════════════════

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { usePipelineStatus } from "./api/api";

const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
  { to: "/kanban", label: "Kanban" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/agents/data-analyst", label: "Agent Detail" },
];

export default function App() {
  const { data: status } = usePipelineStatus();
  const location = useLocation();

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
            Formiga ML
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
        {status?.runId && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-[var(--text-secondary)]">
              Run{" "}
              <code className="text-[var(--text-primary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-xs">
                {status.runId.slice(0, 8)}
              </code>
            </span>
            <span className="flex items-center gap-1.5">
              <span className={`status-dot ${status.status}`} />
              <span className="capitalize text-[var(--text-primary)]">{status.status}</span>
            </span>
            <span className="text-[var(--text-secondary)]">
              Phase: <span className="text-[var(--text-primary)] capitalize">{status.currentPhase.replace(/_/g, " ")}</span>
            </span>
            <span className="text-[var(--text-secondary)]">
              Round {status.currentRound}/{status.maxRounds}
            </span>
          </div>
        )}
      </header>

      {/* Content area */}
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-screen-2xl mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

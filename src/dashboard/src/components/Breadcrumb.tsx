// ══════════════════════════════════════════════════════════════════════
// Breadcrumb.tsx — Navigation trail derived from NAV_ITEMS + useLocation
// ══════════════════════════════════════════════════════════════════════
// No duplicate mapping tables — derives labels from NAV_ITEMS config.
// Shows: Formiga › [Run shortId] › Current Page › [Agent name]
// ══════════════════════════════════════════════════════════════════════

import { Link, useLocation } from "react-router-dom";
import { usePipelineStatus } from "../api/api.js";

const NAV_ITEMS = [
  { to: "/", label: "Command Center", end: true },
  { to: "/kanban", label: "Experiment Board" },
  { to: "/leaderboard", label: "Model Arena" },
];

interface BreadcrumbMatch {
  label: string;
}

function matchPath(pathname: string): BreadcrumbMatch | null {
  const exact = NAV_ITEMS.find((n) => pathname === n.to);
  if (exact) return { label: exact.label };

  const prefix = NAV_ITEMS.find(
    (n) => n.to !== "/" && pathname.startsWith(n.to),
  );
  return prefix ? { label: prefix.label } : null;
}

export function Breadcrumb() {
  const location = useLocation();
  const { data: pipeline } = usePipelineStatus();
  const current = matchPath(location.pathname);

  if (!current || location.pathname === "/") return null;

  const runSegment = pipeline?.runId
    ? { label: `Run ${pipeline.runId.slice(0, 8)}`, href: "/" }
    : null;

  return (
    <nav aria-label="Breadcrumb" className="text-xs text-[var(--text-muted)] py-2 flex items-center gap-1.5">
      <Link to="/" className="hover:text-[var(--text-primary)]">Formiga</Link>
      {runSegment && (
        <>
          <span aria-hidden="true">›</span>
          <Link to={runSegment.href} className="hover:text-[var(--text-primary)]">{runSegment.label}</Link>
        </>
      )}
      <span aria-hidden="true">›</span>
      <span className="text-[var(--text-primary)]">{current.label}</span>
    </nav>
  );
}
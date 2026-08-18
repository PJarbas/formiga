// ══════════════════════════════════════════════════════════════════════
// KanbanRedirect.tsx — /kanban?run=<id> → /pipeline preserving the query
// The old `<Navigate to="/pipeline" replace />` dropped the ?run= the kanban
// link carries, so the pipeline-flow screen always opened the active run
// instead of the one the user selected (issue #128).
// ══════════════════════════════════════════════════════════════════════

import { Navigate, useLocation } from "react-router-dom";

export function KanbanRedirect() {
  const location = useLocation();
  return <Navigate to={`/pipeline${location.search}`} replace />;
}

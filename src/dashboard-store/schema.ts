// ══════════════════════════════════════════════════════════════════════
// dashboard-store/schema.ts — DDL for dashboard-only persistence
// ──────────────────────────────────────────────────────────────────────
// Kept separate from the leaderboard schema: these tables hold UX state
// (spec approval decisions, checklist toggles) that the dashboard owns,
// not numbers that the agents produce.
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";

export const SPEC_APPROVALS_DDL = `
  CREATE TABLE IF NOT EXISTS spec_approvals (
    spec_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    reason TEXT,
    approved_by TEXT,
    approved_at TEXT,
    rejected_at TEXT,
    rejected_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (spec_id)
  );

  CREATE INDEX IF NOT EXISTS idx_spec_approvals_run
    ON spec_approvals(run_id);

  CREATE INDEX IF NOT EXISTS idx_spec_approvals_status
    ON spec_approvals(status);
`;

export const CHECKLIST_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS checklist_state (
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    items_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, phase)
  );
`;

/** Idempotent — safe to call on every server boot. */
export function initDashboardStoreSchema(db: DatabaseSync): void {
  db.exec(SPEC_APPROVALS_DDL);
  db.exec(CHECKLIST_STATE_DDL);
}

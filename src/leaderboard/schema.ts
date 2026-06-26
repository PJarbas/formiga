// ══════════════════════════════════════════════════════════════════════
// schema.ts — DDL for the experiments (leaderboard) table
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";

export const EXPERIMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS experiments (
    experiment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    model_type TEXT NOT NULL,
    hyperparameters TEXT NOT NULL DEFAULT '{}',
    train_metric REAL NOT NULL,
    val_metric REAL NOT NULL,
    test_metric REAL,
    metric_name TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING','SUCCESS','FAILED','AUDITED','OVERFITTED')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_experiments_run_round
    ON experiments(run_id, round_number);

  CREATE INDEX IF NOT EXISTS idx_experiments_val_metric
    ON experiments(val_metric DESC);

  CREATE INDEX IF NOT EXISTS idx_experiments_status
    ON experiments(status);

  CREATE INDEX IF NOT EXISTS idx_experiments_agent
    ON experiments(agent_name, run_id);
`;

/**
 * Additive migration: promote/reject decision columns.
 * Orthogonal to `status` — a model can be SUCCESS *and* promoted.
 * Applied idempotently by introspecting PRAGMA table_info(experiments).
 */
const PROMOTE_REJECT_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "promoted_at", ddl: "ALTER TABLE experiments ADD COLUMN promoted_at TEXT" },
  { name: "rejected_at", ddl: "ALTER TABLE experiments ADD COLUMN rejected_at TEXT" },
  { name: "reject_reason", ddl: "ALTER TABLE experiments ADD COLUMN reject_reason TEXT" },
];

const PROMOTED_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_experiments_promoted
    ON experiments(promoted_at)
    WHERE promoted_at IS NOT NULL;
`;

export function initLeaderboardSchema(db: DatabaseSync): void {
  db.exec(EXPERIMENTS_DDL);

  // Introspect existing columns so re-init is safe.
  const existing = db.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
  const existingNames = new Set(existing.map((row) => row.name));

  for (const col of PROMOTE_REJECT_COLUMNS) {
    if (!existingNames.has(col.name)) {
      db.exec(col.ddl);
    }
  }

  db.exec(PROMOTED_INDEX_DDL);
}

// ══════════════════════════════════════════════════════════════════════
// schema.ts — DDL for the experiments (leaderboard) table
// ══════════════════════════════════════════════════════════════════════

import type { DatabaseSync } from "node:sqlite";

export const DATASET_SIGNATURE_DDL = `
  CREATE TABLE IF NOT EXISTS dataset_signatures (
    signature TEXT PRIMARY KEY,
    column_hash TEXT NOT NULL,
    row_bucket TEXT NOT NULL
  );
`;

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
    dataset_signature TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_experiments_dataset_sig
    ON experiments(dataset_signature, val_metric DESC);
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

/**
 * Additive migration: rich metric columns and problem-type metadata.
 * Applied idempotently by introspecting PRAGMA table_info(experiments).
 */
const RICH_METRICS_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "f1_score",            ddl: "ALTER TABLE experiments ADD COLUMN f1_score REAL" },
  { name: "precision",           ddl: "ALTER TABLE experiments ADD COLUMN precision REAL" },
  { name: "recall",              ddl: "ALTER TABLE experiments ADD COLUMN recall REAL" },
  { name: "roc_auc",             ddl: "ALTER TABLE experiments ADD COLUMN roc_auc REAL" },
  { name: "log_loss",            ddl: "ALTER TABLE experiments ADD COLUMN log_loss REAL" },
  { name: "mae",                 ddl: "ALTER TABLE experiments ADD COLUMN mae REAL" },
  { name: "rmse",                ddl: "ALTER TABLE experiments ADD COLUMN rmse REAL" },
  { name: "r2_score",            ddl: "ALTER TABLE experiments ADD COLUMN r2_score REAL" },
  { name: "metrics_json",        ddl: "ALTER TABLE experiments ADD COLUMN metrics_json TEXT DEFAULT '{}'" },
  { name: "problem_type",        ddl: "ALTER TABLE experiments ADD COLUMN problem_type TEXT" },
  { name: "model_algorithm",     ddl: "ALTER TABLE experiments ADD COLUMN model_algorithm TEXT" },
];

/**
 * Additive migration: arena competitor fields.
 *
 * These columns are declared in prisma/schema.prisma (written by
 * fromArenaExperiment) but were never created by the raw-SQL schema, leaving
 * the two schemas out of sync. Test DBs (and legacy DBs that only run
 * initLeaderboardSchema) were missing them, causing Prisma create() to fail
 * with "column does not exist". This closes the gap additively.
 *
 * Applied idempotently by introspecting PRAGMA table_info(experiments).
 */
const ARENA_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "hypothesis",          ddl: "ALTER TABLE experiments ADD COLUMN hypothesis TEXT" },
  { name: "learned",             ddl: "ALTER TABLE experiments ADD COLUMN learned TEXT" },
  { name: "next_focus",          ddl: "ALTER TABLE experiments ADD COLUMN next_focus TEXT" },
  { name: "measured_metric",     ddl: "ALTER TABLE experiments ADD COLUMN measured_metric REAL" },
  { name: "benchmark_stdout",    ddl: "ALTER TABLE experiments ADD COLUMN benchmark_stdout TEXT" },
  { name: "benchmark_stderr",    ddl: "ALTER TABLE experiments ADD COLUMN benchmark_stderr TEXT" },
  { name: "benchmark_exit_code", ddl: "ALTER TABLE experiments ADD COLUMN benchmark_exit_code INTEGER" },
  { name: "confidence_score",    ddl: "ALTER TABLE experiments ADD COLUMN confidence_score REAL" },
  { name: "confidence_band",     ddl: "ALTER TABLE experiments ADD COLUMN confidence_band TEXT" },
  { name: "decision",            ddl: "ALTER TABLE experiments ADD COLUMN decision TEXT" },
  { name: "duration_ms",         ddl: "ALTER TABLE experiments ADD COLUMN duration_ms INTEGER" },
  { name: "artifact_script",     ddl: "ALTER TABLE experiments ADD COLUMN artifact_script TEXT" },
];

/**
 * Additive migration: journal/ledger fields.
 *
 * The `experiments` table doubles as the arena journal (one row per
 * experiment, append-only verdict). These columns add:
 *  - `fold_scores`:       JSON array of per-fold scores (Nadeau-Bengio input).
 *  - `train_score`:       explicit train score for overfitting gate (distinct
 *                          from `train_metric`, which may be reused as val).
 *  - `content_hash`:      MD5(features ‖ split ‖ config) — intra-run dataset
 *                          integrity (distinct from `dataset_signature`, which
 *                          is for cross-run warm-start).
 *  - `oof_artifact_key`:  reference to the OOF probabilities artifact (for
 *                          ensemble composition + calibration-leak detection).
 *  - `prod_artifact_key`: reference to the production-refit model artifact.
 *  - `brier_raw`/`brier_calibrated`/`ece_calibrated`: calibration diagnostics.
 *  - `notes`:             cross-pollination channel (suggestion to the other
 *                          team), distinct from `learned` (own reflection).
 *  - `verdict_locked_at`: once set, the verdict columns (decision/status/
 *                          reject_reason/rejected_at/promoted_at) are immutable.
 *  - `iteration_team`:    team-scoped iteration counter (budget enforcement).
 *  - `category`:          experiment category (hyperparameter|ensemble|...).
 *
 * Applied idempotently by introspecting PRAGMA table_info(experiments).
 */
const JOURNAL_LEDGER_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "fold_scores",         ddl: "ALTER TABLE experiments ADD COLUMN fold_scores TEXT" },
  { name: "train_score",         ddl: "ALTER TABLE experiments ADD COLUMN train_score REAL" },
  { name: "content_hash",        ddl: "ALTER TABLE experiments ADD COLUMN content_hash TEXT" },
  { name: "oof_artifact_key",    ddl: "ALTER TABLE experiments ADD COLUMN oof_artifact_key TEXT" },
  { name: "prod_artifact_key",   ddl: "ALTER TABLE experiments ADD COLUMN prod_artifact_key TEXT" },
  { name: "brier_raw",           ddl: "ALTER TABLE experiments ADD COLUMN brier_raw REAL" },
  { name: "brier_calibrated",    ddl: "ALTER TABLE experiments ADD COLUMN brier_calibrated REAL" },
  { name: "ece_calibrated",      ddl: "ALTER TABLE experiments ADD COLUMN ece_calibrated REAL" },
  { name: "notes",               ddl: "ALTER TABLE experiments ADD COLUMN notes TEXT" },
  { name: "verdict_locked_at",   ddl: "ALTER TABLE experiments ADD COLUMN verdict_locked_at TEXT" },
  { name: "iteration_team",      ddl: "ALTER TABLE experiments ADD COLUMN iteration_team INTEGER" },
  { name: "category",            ddl: "ALTER TABLE experiments ADD COLUMN category TEXT" },
];

export function initLeaderboardSchema(db: DatabaseSync): void {
  db.exec(DATASET_SIGNATURE_DDL);
  db.exec(EXPERIMENTS_DDL);

  // Introspect existing columns so re-init is safe.
  const existing = db.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
  const existingNames = new Set(existing.map((row) => row.name));

  for (const col of PROMOTE_REJECT_COLUMNS) {
    if (!existingNames.has(col.name)) {
      db.exec(col.ddl);
    }
  }

  // ── Dataset signature migration ──
  // Nullable TEXT column added for cross-run transfer-learning.
  if (!existingNames.has("dataset_signature")) {
    db.exec("ALTER TABLE experiments ADD COLUMN dataset_signature TEXT");
  }

  // ── Rich metrics migration ──
  for (const col of RICH_METRICS_COLUMNS) {
    if (!existingNames.has(col.name)) {
      db.exec(col.ddl);
    }
  }

  // ── Arena competitor columns (sync raw-SQL schema with prisma schema) ──
  for (const col of ARENA_COLUMNS) {
    if (!existingNames.has(col.name)) {
      db.exec(col.ddl);
    }
  }

  // ── Journal/ledger migration ──
  for (const col of JOURNAL_LEDGER_COLUMNS) {
    if (!existingNames.has(col.name)) {
      db.exec(col.ddl);
    }
  }

  db.exec(PROMOTED_INDEX_DDL);
}

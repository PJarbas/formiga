// ══════════════════════════════════════════════════════════════════════
// init.ts — One-shot database bootstrap on server startup
// Replaces run-once DDL + PRAGMA setup from the raw sqlite era.
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "./prisma.js";

/** Run once before the dashboard or CLI main path starts.
 *  Ensures WAL mode, foreign keys, and the singleton stats row exist.
 *  Prisma migrations already created the schema, but SQLite PRAGMAs
 *  and seed rows (formiga_stats) need a raw-query pass.
 */
export async function initDatabase(): Promise<void> {
  const prisma = getPrisma();

  // SQLite-specific pragmas (not available via Prisma DSL for SQLite)
  await prisma.$executeRawUnsafe(`PRAGMA journal_mode=WAL;`);
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=ON;`);

  // Ensure arena_sessions table exists (used by ArenaRepository via Prisma)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS arena_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      metric_name TEXT NOT NULL,
      metric_direction TEXT NOT NULL,
      benchmark_script TEXT NOT NULL,
      checks_script TEXT,
      target_metric REAL,
      max_rounds INTEGER NOT NULL DEFAULT 10,
      max_no_improve INTEGER NOT NULL DEFAULT 3,
      current_round INTEGER NOT NULL DEFAULT 0,
      best_metric REAL,
      best_agent TEXT,
      best_experiment_id INTEGER,
      baseline_metric REAL,
      noise_floor_mad REAL,
      status TEXT NOT NULL DEFAULT 'running',
      total_keep INTEGER NOT NULL DEFAULT 0,
      total_discard INTEGER NOT NULL DEFAULT 0,
      total_crash INTEGER NOT NULL DEFAULT 0,
      total_checks_failed INTEGER NOT NULL DEFAULT 0,
      consecutive_no_improve INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);

  // Ensure the singleton stats row exists
  await prisma.formigaStat.upsert({
    where: { id: 1 },
    create: { id: 1, system_tokens_spent: 0 },
    update: {},
  });
}

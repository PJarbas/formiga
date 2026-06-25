import type { DatabaseSync } from "node:sqlite";

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Backfill run_number for existing runs
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("run_number")) {
    db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
    runColNames.add("run_number");
    db.exec(`
      UPDATE runs SET run_number = (
        SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
      ) WHERE run_number IS NULL
    `);
  }

  if (!runColNames.has("tokens_spent")) {
    db.exec("ALTER TABLE runs ADD COLUMN tokens_spent INTEGER NOT NULL DEFAULT 0");
  }

  db.exec("UPDATE runs SET tokens_spent = 0 WHERE tokens_spent IS NULL");

  // ── Run-scoped scheduling metadata ──
  // - scheduling_status: lifecycle of daemon-side scheduling for the run
  //   (pending_register | active | queued | paused | error | NULL)
  // - scheduling_requested_at: ISO ts used for FIFO admission ordering
  // - scheduling_error: human-readable reason when scheduling_status='error'
  if (!runColNames.has("scheduling_status")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_status TEXT");
  }
  if (!runColNames.has("scheduling_requested_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_requested_at TEXT");
  }
  if (!runColNames.has("scheduling_error")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_error TEXT");
  }

  // ── Worker ownership columns for steps ──
  // Tracks which polling worker process (job/PID/PGID) claimed each step.
  // Nullable — legacy rows stay NULL, ownership-agnostic callers are unaffected.
  const stepCols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const stepColNames = new Set(stepCols.map((c) => c.name));
  if (!stepColNames.has("claim_job_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_job_id TEXT");
  }
  if (!stepColNames.has("claim_pid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pid INTEGER");
  }
  if (!stepColNames.has("claim_pgid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pgid INTEGER");
  }
  if (!stepColNames.has("claim_updated_at")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_updated_at TEXT");
  }

  // Indexes for run-scoped scheduling and step claim queries.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_steps_agent_run_status ON steps(agent_id, run_id, status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_status_sched ON runs(status, scheduling_status, scheduling_requested_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_sched_queue ON runs(scheduling_status, scheduling_requested_at, created_at)",
  );

  // ── Global stats ──
  const statsTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='formiga_stats'",
  ).get();
  if (!statsTableExists) {
    db.exec(`
      CREATE TABLE formiga_stats (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        system_tokens_spent INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec("INSERT OR IGNORE INTO formiga_stats (id, system_tokens_spent) VALUES (1, 0)");
  }

  // ── Worktree tracking ──
  // Tracks managed git worktrees created for run workspace isolation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_worktrees (
      run_id TEXT PRIMARY KEY,
      worktree_origin_repository TEXT NOT NULL,
      worktree_origin_git_common_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_origin_ref TEXT,
      worktree_origin_sha TEXT,
      original_branch TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      cleanup_policy TEXT NOT NULL DEFAULT 'remove_on_success',
      created_at TEXT NOT NULL,
      removed_at TEXT,
      error TEXT
    );
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_run_worktrees_status ON run_worktrees(status)",
  );

  // ── AutoResearch session registry ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS autoresearch_sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      goal TEXT,
      metric_name TEXT,
      metric_unit TEXT,
      direction TEXT,
      command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_run_at TEXT,
      total_runs INTEGER NOT NULL DEFAULT 0,
      baseline_metric REAL,
      best_metric REAL,
      best_run INTEGER,
      files_missing INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_autoresearch_sessions_cwd ON autoresearch_sessions(cwd)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_autoresearch_sessions_updated_at ON autoresearch_sessions(updated_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_autoresearch_sessions_last_seen_at ON autoresearch_sessions(last_seen_at)",
  );
}

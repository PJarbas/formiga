# Formiga — Architecture & Overview

> **Formiga** is a multi-agent platform that automates the full Machine Learning experimentation cycle — EDA, feature engineering, training, tuning, and final reporting — through AI agents that compete in a structured "Arena".

This is the project's single reference document. It describes the problem Formiga solves, its architecture, the MCP server, agent communication, the Arena race, and how results are produced.

---

## Table of contents

1. [The problem it solves](#1-the-problem-it-solves)
2. [Layered architecture](#2-layered-architecture)
3. [Workflows and the "arena" step](#3-workflows-and-the-arena-step)
4. [Scheduler and orchestration (claim-based)](#4-scheduler-and-orchestration-claim-based)
5. [Database](#5-database)
6. [MCP server (formiga-agent-tools)](#6-mcp-server-formiga-agent-tools)
7. [Agent communication](#7-agent-communication)
8. [The Arena race](#8-the-arena-race)
9. [Pre-write auditor (quality gates)](#9-pre-write-auditor-quality-gates)
10. [Agents and their roles](#10-agents-and-their-roles)
11. [Dashboard and APIs](#11-dashboard-and-apis)
12. [Architectural patterns](#12-architectural-patterns)

---

## 1. The problem it solves

Data scientists spend up to 80% of their time on repetitive tasks: exploring data, engineering features, tuning hyperparameters, comparing models. Formiga automates this cycle end to end by spawning a team of autonomous AI agents that work like a collaborative data science squad — exploring, experimenting, competing in a structured Arena, and delivering production-ready models.

**Key features:**
- **Parallel experimentation:** classic, advanced, and creative ML agents compete simultaneously.
- **Iterative improvement (Arena):** the modeling loop runs multiple rounds, adapting based on prior rounds' learnings.
- **Statistical rigor:** every experiment is audited before entering the ledger — significance (Nadeau-Bengio), overfitting, calibration leakage, dataset integrity.
- **Full auditability:** every feature decision, model architecture, and hyperparameter is recorded in an append-only ledger.
- **Live dashboard:** watch the execution DAG, engineered features, and leaderboard rankings in real time.

**Stack:** Node.js 22+ (ESM, TypeScript), SQLite (via Prisma + native `node:sqlite`), React 19 (dashboard). Formiga does **not** call LLMs directly — it spawns external agent harnesses (`pi-coding-agent` or `hermes`) as child processes.

---

## 2. Layered architecture

```
CLI (bin/formiga) ─────────────────────┐
                                       ▼
                    SQLite (~/.formiga/formiga.db)
                                       ▲
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
   Daemon / Scheduler          Agent Harness (pi/hermes)    Dashboard API (:3334)
   (orchestrates the DAG,      (spawns the AI agents)       (React SPA + REST + MCP)
    cron + event-driven)            │                          │
            │                        ▼                          │
            │              AI Agents (data-analyst,             │
            │              feature-engineer, modelers,          │
            │              reporter) ──write/read──► SQLite ◄───┘
            ▼
   Arena Engine (multi-round competition)
```

Formiga is lightweight, asynchronous, and resilient. There is no direct messaging between agents (no Redis/RabbitMQ/SSE between them) — **every handoff goes through the shared SQLite**. Agents are isolated processes that write to and read from the database; the scheduler coordinates who executes what.

**Default ports:**
- **Dashboard + MCP:** `3334` (MCP runs embedded in the dashboard at the `/mcp` route; it has no port of its own).
- **Control plane:** `3339` (run-scoped scheduling, separate).

---

## 3. Workflows and the "arena" step

A workflow is declared in YAML (`workflows/<id>/workflow.yml`) defining `agents` (with workspace, skills, and persona files `AGENTS.md`/`IDENTITY.md`/`SOUL.md`) and `steps` (a linear DAG, with `parallel_group` for parallelism). Step inputs use template substitution (`{{dataset_path}}`, `{{run_id}}`, etc.).

### ml-autoresearch (primary workflow)

```
eda → features → arena → report
```

- **`eda`** (data-analyst): rigorous EDA, produces `eda_report` + `eda_config`.
- **`features`** (feature-engineer): produces `features.parquet`, `split.pkl`, baseline, `benchmark_config.json`, `benchmark_runner.py`.
- **`arena`** (special step): **not executed by a single agent** — the runner detects `step_id === "arena"` and invokes `runArena()` (the competition engine). Marked `max_retries: 0`.
- **`report`** (reporter): consolidates the competition and writes the final report.

### ml-pipeline (legacy workflow)

```
eda → features → (model-classic ∥ model-advanced) → audit
```

The two modelers use `parallel_group: modelers` to compete concurrently; `audit` (the `ml-critic` agent) is only claimable after both complete.

### Arena step detection

`src/installer/scheduler/direct-spawn.ts` intercepts the `arena` step: instead of spawning the harness, it calls `launchArenaFromStep()` (in `src/arena/arena-workflow.ts`), which builds the `ArenaConfig` from `run.context` + `benchmark_config.json`, runs `runArena()`, and then `completeStep()` to advance the pipeline. The arena step is also **excluded from the heartbeat-failure circuit** (its owner is the arena engine, not the polling loop).

---

## 4. Scheduler and orchestration (claim-based)

Work is distributed by a **polling-based, run-scoped claim model**. Each agent has a cron job (run_id, agent_id) that periodically asks "is there work?" and atomically "claims" a step.

### A tick's lifecycle (`src/installer/scheduler/polling-round.ts`)

1. **In-flight guard** (race-safe, synchronous before any await) — prevents duplicate spawns.
2. **Pending-work check** — queries `pending`/`waiting` steps for the (run, agent); if empty, applies heartbeat backoff and returns.
3. **Pre-claim** — `claimStep()` BEFORE spawning the harness (eliminates the bug class where the model mistypes the discovery/claim command — the step is already claimed and injected into the prompt).
4. **Harness spawn** — `pi --print` or `hermes`, with stdout streamed to disk (prevents OOM). `onSpawn` records pid/pgid for orphan recovery.
5. **Output classification** — `heartbeat` / `work_done` / `other_output`.
6. **Auto-complete fallback** — if the output contains `STATUS: done` but the agent didn't call the CLI, the step is completed automatically.

### Atomic claim (`src/installer/steps/claim.ts`)

`claimStep()` runs raw SQL (Prisma can't express the self-join): it selects `pending` steps for the (agent, run) where **no previous step** (`step_index <`) has a status other than `done`/`skipped` — enforcing serial pipeline progression. Two exceptions:
- **`verify_each`:** a `running` loop step with no `current_story_id` doesn't block verify.
- **`parallel_group`:** siblings in the same group don't block each other (parallelism).

The claim is atomic via `updateMany WHERE status='pending'` — concurrent workers can't double-claim. For `loop` steps (`over: stories`), it atomically advances to the next `pending` story.

### Event-driven acceleration

`postAdvanceSpawn()` (`src/installer/steps/complete.ts`) calls `spawnAgentsForPendingSteps()` (`src/installer/scheduler/direct-spawn.ts`) — when a step completes, the next one is dispatched immediately (<1s) instead of waiting for the next cron tick. Falls back to cron if direct-spawn fails.

### Recovery and observability

- **Stale-claim sweeper:** reclaims steps from dead processes (threshold `timeout * 1.5`).
- **Heartbeat-failure circuit:** after N consecutive heartbeats with no progress, fails the step terminally — except the `arena` step.
- **Observability columns** on `Step`: `claim_job_id`/`claim_pid`/`claim_pgid`/`claim_updated_at`, `consecutive_heartbeats`, `spawn_count`, `last_outcome`/`last_outcome_at`.
- **Medic:** a watchdog that detects stuck steps, zombie runs, and auto-remediates.

---

## 5. Database

**Engine:** SQLite at `~/.formiga/formiga.db` (overridable via `FORMIGA_DB_PATH`). Singleton connection with `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`.

### Main models (`prisma/schema.prisma`)

| Model | Purpose |
|---|---|
| **`Run`** | A full workflow execution. Has `status`, `context` (shared JSON), `tokens_spent`, scheduling fields. |
| **`Step`** | A unit of work for an agent. Logical `step_id`, `agent_id`, `step_index`, `input_template`, `expects`, `status` (waiting/pending/running/done/failed/skipped), `type` (single/loop), `parallel_group`, claim and observability fields. |
| **`Story`** | An iteration unit inside a `loop` step (`over: stories`). |
| **`Experiment`** | **Doubles as leaderboard + arena journal** (one row per experiment, append-only verdict). Rich metrics, journal fields (fold_scores, content_hash, notes, verdict_locked_at), `decision` (keep/discard/crash/baseline/checks_failed), `status` (PENDING/SUCCESS/FAILED/AUDITED/OVERFITTED). |
| **`ArenaSession`** | Competition state (1:1 with Run): metric, best, rounds, convergence counters. |
| **`AgentArtifact`** | JSON artifacts persisted by agents via `save_artifact`. Unique on `(run_id, artifact_key)`. |
| **`AgentEvent`** | Activity log: tool calls, thinking, step events, round summaries. |
| **`DatasetSignature`** | Hash of columns+rows for cross-run warm-start. |

Others: `RunWorktree` (git isolation), `SpecApproval`/`ChecklistState` (UX), `JobRegistry` (polling jobs for crash recovery), `FormigaStat` (global tokens), `MedicCheck` (health checks).

### Migrations — two idempotent layers

There is no `prisma/migrations` folder; `prisma migrate deploy` is a no-op. The schema is applied via raw DDL with `PRAGMA table_info` introspection (additive — `ALTER TABLE ADD COLUMN` only if the column doesn't exist):

- `src/database/migrations.ts` — `migrate(db)`: creates `runs`, `steps`, `stories`, `arena_sessions`, `agent_events`, etc.
- `src/leaderboard/schema.ts` — `initLeaderboardSchema(db)`: creates `experiments` + additive migrations in arrays (`ARENA_COLUMNS`, `JOURNAL_LEDGER_COLUMNS`, etc.).
- `src/database/init.ts` — `initDatabase()`: runs `migrate(getDb())` once at startup, before any Prisma write.

---

## 6. MCP server (formiga-agent-tools)

Formiga exposes an **MCP** (Model Context Protocol, JSON-RPC 2.0) server embedded in the dashboard (`src/mcp/server.ts`), at the `/mcp` route. It is the extension agents use to interact with Formiga — writing and reading artifacts, logging decisions, reporting metrics, querying the leaderboard and the arena. **Every agent→Formiga interaction is a tool call**, never `curl`.

### The 6 tools (`src/mcp/tools/`)

| Tool | Mode | What it does |
|---|---|---|
| **`save_artifact`** | fire-and-forget | Persists structured JSON to the dashboard (`key` + `data`, max 500KB). |
| **`read_artifact`** | synchronous | Reads an artifact by `key`, or lists all artifacts for the run if `key` is omitted. The read counterpart to `save_artifact`. |
| **`log_decision`** | fire-and-forget | Audit trail of decisions (`model_selection`, `feature_drop`, `hyperparameter`, etc.). Saved as an artifact with a sequential key. |
| **`report_metric`** | fire-and-forget | Reports a numeric metric (`name` + `value` + `tags`). Saved as a `metric_<name>` artifact. |
| **`query_leaderboard`** | synchronous | Returns the top-N experiments (CV, train, gap, round) so the agent can decide its next approach. |
| **`query_arena`** | synchronous | Reads arena state: `view` = `session` (best, rounds, convergence), `rounds` (experiments per round), or `convergence` (metric time series). |

**Design (SOLID):**
- **ISP** — segregated interfaces: `IArtifactService`, `ILeaderboardService`, `IArenaService` (arena ≠ ranking).
- **DIP** — services receive injected repositories; they map internal rows to stable read models (no `ExperimentRow` leakage).
- **SRP** — handlers only validate (allowlist) + format; services only map.
- **Security** — inputs validated by allowlist (e.g. `view` ∈ {session, rounds, convergence}), key regex, size limits.

The `ToolContext` (runId/stepId/agentId) is extracted from `params._meta` or the env vars `FORMIGA_RUN_ID`/`FORMIGA_STEP_ID`/`FORMIGA_AGENT_ID`.

---

## 7. Agent communication

Communication happens **through the database (SQLite), not via direct messages**. Multiple channels:

### 7.1 Artifacts (`save_artifact` / `read_artifact`) — primary channel

Each agent writes structured JSON to the `agent_artifacts` table (`eda_report`, `features_report`, `benchmark_config`, `modeler-classic_report_roundN`, `arena_report`, etc.); downstream agents read it via `read_artifact` or HTTP GET. Personas explicitly declare: **"bank artifacts are the source of truth"** — legacy `.md` files are optional. Using `curl` to write or read artifacts is forbidden.

Narrative handoff pipeline:
```
data-analyst ──save_artifact("eda_report")──► SQLite ──read_artifact──► feature-engineer
feature-engineer ──save_artifact("features_report")──► SQLite ──read_artifact──► modelers
modelers ──save_artifact("modeler-X_report_roundN")──► SQLite ──read_artifact──► reporter
reporter ──save_artifact("arena_report")──► SQLite
```

### 7.2 `Run.context` — shared context

A JSON string for the run, populated with template variables (`dataset_path`, `target_column`, `workspace`, etc.) read by steps. `arena-workflow.ts` reads `run.context` to build the `ArenaConfig`.

### 7.3 `Experiment.notes` — cross-pollination

A channel for suggestions directed **at the other team**, distinct from `learned` (own reflection). The arena engine injects the other teams' `notes` into the next round's prompt as "### Sugestões do Outro Time" (Suggestions from the Other Team). modeler-creative has `notes` as required — it is its main channel of contribution to the ensemble.

### 7.4 `query_leaderboard` / `query_arena` — synchronous state reads

Modelers query the leaderboard before deciding their next approach; the reporter queries arena state (session/rounds/convergence) for the final report.

### 7.5 Cross-run warm-start

`leaderboardRepo.getBestByDatasetSignature(signature, 3)` injects the 3 best past results for the same dataset (via `dataset_signature`) into round 1 — transfer learning across runs.

### 7.6 CLI `formiga message`

There is a secondary agent→agent channel via `sendMessage`/`listMessages`/`readMessage` (persisted as artifacts), but it is not referenced in the ml-autoresearch personas — artifact handoff is the canonical channel.

---

## 8. The Arena race

The competition engine (`src/arena/arena-engine.ts`, `runArena()`) is the heart of ml-autoresearch. Three teams of modelers compete across multiple rounds to achieve the best metric.

### Setup

1. Creates the `ArenaSession` in the database.
2. Establishes the baseline by reading `benchmark_config.json` (or running the benchmark with `baseline.pkl`).
3. Reads the dataset context once; derives the compute budget from the complexity tier (RF-#90).
4. **Tier gate:** if the dataset is `medium`/`large`, uses all 3 teams; otherwise filters out `modeler-creative` (negative ROI on TINY/SMALL).
5. **Warm-start:** injects the 3 best past results for this dataset.
6. Loads the `content_hash` (MD5 of features‖split‖config) as the intra-run integrity anchor.

### Round loop (up to `max_rounds`)

For each round:

1. **`buildPromptsForRound()`** — builds the per-agent prompt with: its own history, the other teams' `keep`/`baseline` results, **cross-pollination notes**, warm-start hints (round 1), JSON output rules (`_results.json`), and the rich-metrics contract.

2. **Parallel fan-out** — `runAgentsParallel()` spawns all active teams simultaneously (`pi --print --mode json` with the `formiga-agent-tools` extension). Each agent generates a standalone Python script that trains and evaluates a model.

3. **Sequential measurement** (resource contention) — for each agent:
   - Writes the generated Python script to `artifacts/models/<agent>_round<N>.py`.
   - `trainScript()` spawns `python3` detached (process group) with an `RLIMIT_CPU` prelude and budget env vars. Timeout = min(180s, budget). Graceful tree kill: SIGTERM → SIGKILL after 2s.
   - `extractMetric()` parses `<metric_name>: <value>` from stdout/stderr.
   - `tryLoadRichMetrics()` reads the `_results.json` sidecar: `fold_scores`, `train_score`, `oof_path`/`prod_path`, `brier_*`, `ece_calibrated`, `n_unique_probs`, `notes`, `category`.

4. **Pre-write audit** — `auditExperiment()` (see §9) runs BEFORE persisting; it may reject, downgrade to `warn`, or keep `keep`.

5. **Persistence** — `registerArena()` writes the `Experiment` with all journal fields (including `verdict_locked_at` — append-only ledger).

6. **Promotion** — only `keep`/`baseline` (statistically significant) entries promote `bestMetric`/`bestAgent` and reset the no-improve counter. The new best's `fold_scores` are captured for the next Nadeau-Bengio test.

### Convergence

Stops at `target_reached` (target metric hit), `converged` (`consecutiveNoImprove >= maxNoImprove`), or `max_rounds`.

### The three teams (segregated territories)

| Team | Territory | Anti-invasion |
|---|---|---|
| **modeler-classic** | GBM (XGB/LGBM/CatBoost), linear, trees, SVM/KNN, Stacking L1 | No NN/AutoML |
| **modeler-advanced** | MLP, TabNet, FT-Transformer, TabPFN, AutoML, multi-level Stacking, Entity Embeddings | No standard GBM/linear |
| **modeler-creative** | DAE, aggressive mRMR, target permutation, monotonic constraints, Bayesian blending, SHAP interactions | No standard approaches; goal is **decorrelation** (Spearman OOF corr <0.85 vs top-1) |

Each team has a budget of up to 5 iterations and an early-stop rule: if iteration N didn't beat the best with significance and there's no differentiated hypothesis, stop.

---

## 9. Pre-write auditor (quality gates)

`src/arena/audit.ts` — `auditExperiment()` is a pure function that runs **before** the experiment enters the ledger (the synchronous `auto_critic` equivalent). Verdicts: `keep` | `warn` | `rejected`.

### Gates in order (first REJECTED stops)

| Gate | Tag | Rule |
|---|---|---|
| **G7** dedup | `budget` | `(team, model_type, hyperparams, metric)` identical to a prior entry → `[dedup]`. Not persisted, doesn't consume a slot. |
| **G6** budget | `budget` | Team reached `maxIterationsPerTeam` (5) → `[budget]`. Still persisted for transparency. |
| **G2** content_hash | `stale` | Experiment `contentHash` ≠ session hash → `[stale]` (dataset was regenerated). |
| **G3** no_folds | `no_folds` | `fold_scores` missing or <2 → `[no_folds]` (no folds means no Nadeau-Bengio). |
| **G1** overfit | `overfit` | `|train - val| > threshold(tier)` (TINY=0.06, SMALL=0.05, MEDIUM/LARGE=0.03). |
| **G4** cal_leak | `cal_leak` | OOF with <50 unique probs (saturation) OR ECE <1e-6 (suspiciously perfect — calibrator fit on OOF). |
| **G5** too_good | warning | Univariate AUC ≥0.99 (likely a target proxy). Does not reject. |
| **G8** significance | warning | Nadeau-Bengio tier-specific thresholds: TINY (`p<0.20 ∧ delta≥0.1pp`), SMALL (`p<0.10 ∧ delta≥0.3pp`), MEDIUM+ (`p<0.05 ∧ delta≥0.5pp`). Falls below → downgrade to `warn` (stays in the ledger, not promoted). |

### Nadeau-Bengio (significance)

A fold-overlap-corrected t-test (Nadeau & Bengio 2003): `correction = 1/n + (n-1)/n`. Thresholds are **tier-specific**: TINY datasets (≤30 samples/fold) use relaxed criteria because CV noise dominates — `p < 0.20` and `delta ≥ 0.1pp`. SMALL uses `p < 0.10` and `delta ≥ 0.3pp`. MEDIUM and above use the standard `p < 0.05` and `delta ≥ 0.5pp`. Custom t-Student implementation (regularized incomplete beta via continued-fraction) — no external stats dependency.

### Append-only ledger

`registerArena()` sets `verdict_locked_at` on insert. After that, `reject`/`autoAudit`/`updateTestMetric` throw (verdict immutability). `setDatasetSignature` is exempt (pre-verdict metadata). Display fields are kept separate from ledger fields.

### Nelder-Mead ensemble

`nelderMeadEnsembleWeights(nModels, score)` optimizes weights over the simplex Δⁿ (weights ≥0, sum to 1) for OOF blending. Used by the reporter — not an auditor gate.

---

## 10. Agents and their roles

Each agent has persona files in `workflows/ml-autoresearch/agents/<id>/` (`AGENTS.md` + `IDENTITY.md` + `SOUL.md`).

1. **data-analyst** — rigorous EDA, read-only (no training). 9 required report sections. Techniques: Mutual Information, Cramer's V, Theil's U, point-biserial (leakage flag >0.70), Kolmogorov-Smirnov (drift), Fisher skewness. ≥5 actionable hypotheses. Saves `eda_report` + `eda_config`.

2. **feature-engineer** — consumes EDA, produces the canonical matrix + split + baseline + benchmark scripts. **The sole creator of splits.** Compute budget derived from the tier. `content_hash` MD5. **Feature Quality Gate** with 10 blocking gates (colinearity, VIF, **adversarial validation** >0.80 = abort, too-good, Nogueira stability, missing, dimensionality, CV-internal leakage, near-zero variance, bit-identical re-execution). Leakage-proof target encoding (fit-per-fold). OOT holdout as the official production metric. Saves `features_report`.

3. **arena-modeler-classic** — classic ML (GBM, linear, trees, SVM, Stacking L1). Leakage-proof calibration (IsotonicRegression fit on train, predict on OOF — never `iso.fit(oof,y).predict(oof)`). No `scale_pos_weight`/`class_weight` for AUC. `_results.json` required with `fold_scores` + `train_score`. `_prod.pkl` = 1 model refit on 100% non-OOT. Saves `modeler-classic_report_roundN` with `notes`.

4. **arena-modeler-advanced** — advanced ML (MLP, TabNet, FT-Transformer, TabPFN, AutoML, multi-level stacking, entity embeddings). Re-instantiate the model from scratch each fold (`set_seed(42 + fold)`), never share weights. Auto-reject if `train_val_gap > 0.08`. Same calibration/prod/notes rules.

5. **arena-modeler-creative** — the third team, **diversity**. Its success metric is decorrelation (Spearman OOF corr <0.85 vs top-1). Territory: DAE (swap noise), aggressive mRMR, target permutation, monotonic constraints, Bayesian blending, SHAP interactions. Only active on MEDIUM/LARGE. `notes` required (cross-pollination is its main channel). Saves `modeler-creative_report_roundN` with the decorrelation metric.

6. **reporter** — consolidates the competition, writes the final report. Read-only for model artifacts. **Final ensemble via Nelder-Mead/SLSQP** over the OOFs of the top-5 most decorrelated (drops pairs with |corr|≥0.95). **OOT holdout as the official production metric** (loads the winner's `_prod.pkl`, predicts on OOT, computes AUC/Brier/ECE; if OOT AUC drops >5pp vs CV → severe concept drift). Single vs ensemble distinction via the "statistically just" criterion. Saves `arena_report` + `competition_timeline`.

---

## 11. Dashboard and APIs

**Port 3334** (default, overridable via `--port`/`FORMIGA_DASHBOARD_URL`). Native Node HTTP server (no framework) serving a React SPA (built with Vite) + REST API + the embedded MCP server.

### What it shows

- **Pipeline Flow** — live graphical DAG of agent execution; clicking a node reveals insights, generated code, and logs.
- **Leaderboard** — ranking of all models with task-adaptive metrics (classification: accuracy/f1/precision/recall/AUC; regression: RMSE/MAE/R²). Shows the real algorithm class (e.g. `LogisticRegression (Poly)`).
- **Command Center** — run control (pause/resume/cancel), live logs (SSE).
- **Winner Consolidation** — crowns the winner and compiles the final report when the Arena converges.

### Main endpoints

- `GET /api/runs`, `/api/runs/:id` — list/detail of runs.
- `GET /api/runs/:id/agent-artifacts/:key` — read artifact (used by `read_artifact`).
- `POST /api/runs/:id/agent-artifacts/:key` — save artifact (used by `save_artifact`).
- `GET /api/leaderboard`, `/api/leaderboard/agent-history`, `/api/leaderboard/current-best` — leaderboard queries.
- `GET /api/arena/:runId/{session,rounds,convergence}` — arena state.
- `GET /api/events`, `/api/logs-tail` — global events (SSE).
- `POST/GET/DELETE /mcp`, `GET /mcp/info` — embedded MCP server.

### Control plane (port 3339)

A separate run-scoped scheduling API — which agent is polling, dispatch of work sessions. CLI: `formiga control-plane start|stop|status`.

---

## 12. Architectural patterns

| Pattern | Application |
|---|---|
| **Claim-based scheduling** | Steps in the DB with `status: pending`; agents atomically claim via `updateMany WHERE status='pending'`. Race-safe, crash-safe. |
| **Repository Pattern** | `LeaderboardRepositoryImpl`/`ArenaRepositoryImpl` isolate SQLite from business logic. |
| **Interface Segregation (ISP)** | `LeaderboardReadonly`/`ArenaReadonly` separate from write interfaces; `IArenaService` segregated from `ILeaderboardService`. |
| **Dependency Inversion** | Services receive injected repositories; handlers depend on service interfaces. |
| **Additive Migration** | `PRAGMA table_info()` introspection — `ALTER TABLE ADD COLUMN` only if the column doesn't exist. Old databases don't break. |
| **Template Substitution** | `{{...}}` keys resolved in the YAML to pass paths/context between steps. |
| **Sidecar JSON** | `_results.json` separate from stdout — the harness normalizes stdout and may drop lines; the sidecar is the deterministic channel. |
| **Append-only ledger** | `Experiment` with `verdict_locked_at` — the verdict is immutable after commit. |
| **Pre-write audit** | Quality gates run BEFORE persisting, not after. |
| **Determinism** | `random_state=42` required; `split.pkl` immutable; bit-identical re-execution verified by MD5. |
| **Read-only audit** | Audit/report agents don't mutate model artifacts. |
| **Territory segregation** | The 3 arena teams have distinct territories to maximize diversity. |

---

## Technical decisions that support the system

1. **Dataset signature is computed in the runner, not in the agents** — guarantees determinism and that everyone uses the same signature (cross-run warm-start).
2. **Per-run isolated workspace** — avoids polluting the root directory and enables auditing.
3. **Baseline defined by the feature-engineer, not by the modelers** — guarantees an honest, comparable floor.
4. **Leaderboard uses `val_metric` as the primary score** — the auditor/reporter can later evaluate with test/OOT, but ranking is by validation.
5. **Schema is additive** — new columns can be added without destroying old databases.
6. **MCP embedded in the dashboard** — a single port serves SPA + REST + MCP; no separate service.
7. **Every read is a tool** — `read_artifact`, `query_leaderboard`, `query_arena`; zero `curl` in the personas.
8. **`Experiment` is the journal** — one table doubles as leaderboard and append-only ledger, instead of two sources of truth.

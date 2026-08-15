// ══════════════════════════════════════════════════════════════════════
// dashboard-ml-api.test.ts — Integration tests for ML dashboard API
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createDashboardServer } from "../../dist/server/dashboard.js";
import { initLeaderboardSchema } from "../../dist/leaderboard/schema.js";

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = await createDashboardServer(0);
  if (!server.listening) {
    await new Promise((resolve) => server.on("listening", resolve));
  }
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function stopDashboard(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function fetchJSON(url: string): Promise<unknown> {
  const resp = await fetch(url);
  return resp.json();
}

describe("ML Dashboard API", () => {
  let root: string;
  let db: DatabaseSync;
  let server: http.Server;
  let baseUrl: string;
  /** Arena integration fixtures (B1/C2 script+report + FAILED distinction). */
  const arenaIds: Record<string, number> = {};

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-ml-api-"));
    const homeDir = path.join(root, "home");
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    db = new DatabaseSync(dbPath);
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
    `);
    initLeaderboardSchema(db);

    // Insert a running run with experiments
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-ml-001', 1, 'ml-pipeline', 'Test ML Pipeline', 'running', '{}', 5000, '2026-06-25T10:00:00.000Z', '2026-06-25T10:30:00.000Z')
    `).run();

    // Seed experiments across 3 rounds for multiple agents
    const agents = ["data-analyst", "feature-engineer", "modeler-classic", "modeler-advanced", "ml-critic"];
    const models = ["XGBoost", "LinearRegression", "RandomForest", "SVM", "NeuralNetwork", "TabNet", "Stacking"];

    for (let round = 1; round <= 3; round++) {
      for (const agent of agents) {
        const modelType = models[(round + agents.indexOf(agent)) % models.length];
        const valMetric = 0.7 + Math.random() * 0.25;
        const trainMetric = valMetric + Math.random() * 0.08;
        let status = "SUCCESS";
        if (agent === "ml-critic") status = round === 3 ? "AUDITED" : "SUCCESS";
        if (round === 2 && agent === "modeler-advanced") status = "FAILED";

        db.prepare(`
          INSERT INTO experiments (run_id, round_number, agent_name, model_type, hyperparameters,
            train_metric, val_metric, metric_name, artifact_path, status, error_message)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'accuracy', ?, ?, ?)
        `).run(
          "run-ml-001",
          round,
          agent,
          modelType,
          JSON.stringify({ lr: 0.01 }),
          trainMetric,
          valMetric,
          `/tmp/model_${round}_${agent}.pkl`,
          status,
          status === "FAILED" ? `Test error for ${agent}` : null,
        );
      }
    }

    // ── Arena integration fixtures (B1 script-first / C2 report builder /
    //    FAILED-with-reason distinction) ──────────────────────────────
    // A dedicated run so the workspace points at a real, seeded dir and the
    // arena/FAILED experiments don't disturb the ml-pipeline leaderboard
    // totals. Workspace files mirror what the arena loop leaves behind:
    //   reports/<agent>.md  — pre-built ml-pipeline reports
    //   artifacts/models/*.py — the modeler's real reproduction script
    const arenaWs = path.join(root, "workspace-arena-int");
    fs.mkdirSync(path.join(arenaWs, "reports"), { recursive: true });
    fs.mkdirSync(path.join(arenaWs, "artifacts", "models"), { recursive: true });
    fs.writeFileSync(path.join(arenaWs, "reports", "01_eda.md"), "EDA MARKER CONTENT\n");
    const ARENA_REAL_SCRIPT = 'print("f1: 0.82")\nprint("done")';
    const arenaRealScriptPath = path.join(arenaWs, "artifacts", "models", "modeler-classic_round1.py");
    fs.writeFileSync(arenaRealScriptPath, ARENA_REAL_SCRIPT);

    // Not `running` and created BEFORE run-ml-001, so findActivePipelineRunId
    // keeps treating run-ml-001 as the active pipeline — the arena fixtures
    // below are always addressed by explicit `runId=run-arena-int`.
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-arena-int', 2, 'ml-autoresearch', 'Arena Test', 'completed', ?, 0, '2026-06-25T09:00:00.000Z', '2026-06-25T09:00:00.000Z')
    `).run(JSON.stringify({ workspace: arenaWs }));

    const insertArenaExp = db.prepare(`
      INSERT INTO experiments (
        run_id, round_number, agent_name, model_type, hyperparameters,
        train_metric, val_metric, metric_name, artifact_path, status,
        problem_type, metrics_json, fold_scores,
        hypothesis, learned, next_focus,
        error_message, benchmark_exit_code, artifact_script
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    function seedArena(rec: Record<string, unknown>): number {
      const r = insertArenaExp.run(
        "run-arena-int",
        rec.round_number,
        rec.agent_name,
        rec.model_type ?? "LightGBM",
        JSON.stringify(rec.hyperparameters ?? { lr: 0.01 }),
        rec.train_metric ?? 0,
        rec.val_metric ?? 0,
        rec.metric_name ?? "f1",
        rec.artifact_path ?? `/tmp/arena_${rec.agent_name}.pkl`,
        rec.status ?? "SUCCESS",
        rec.problem_type ?? "classification",
        rec.metrics_json ? JSON.stringify(rec.metrics_json) : "{}",
        rec.fold_scores ? JSON.stringify(rec.fold_scores) : null,
        rec.hypothesis ?? null,
        rec.learned ?? null,
        rec.next_focus ?? null,
        rec.error_message ?? null,
        rec.benchmark_exit_code ?? null,
        rec.artifact_script ?? null,
      );
      return Number(r.lastInsertRowid);
    }

    // artifact_script → 200 with preamble + the real script.
    arenaIds.script = seedArena({
      round_number: 1, agent_name: "modeler-classic",
      train_metric: 0.85, val_metric: 0.82,
      metrics_json: { f1_score: 0.82 }, fold_scores: [0.8, 0.82, 0.84],
      artifact_script: arenaRealScriptPath,
    });
    // no artifact_script → generated template.
    arenaIds.scriptFallback = seedArena({
      round_number: 2, agent_name: "modeler-classic",
      train_metric: 0.84, val_metric: 0.81,
    });
    // arena agent NOT in AGENT_REPORT_MAP + no report file → builder 200.
    arenaIds.reportBuilder = seedArena({
      round_number: 1, agent_name: "modeler-creative",
      model_type: "CatBoost", train_metric: 0.83, val_metric: 0.79,
      hypothesis: "Hipótese do criativo",
      learned: "Aprendizado X", next_focus: "Foco Y",
      metrics_json: { f1_score: 0.79, feature_importances: [0.4, 0.3] },
      fold_scores: [0.78, 0.79, 0.80],
    });
    // mapped agent (data-analyst → 01_eda.md) with the file present → file served.
    arenaIds.reportMapped = seedArena({
      round_number: 1, agent_name: "data-analyst", val_metric: 0.7,
    });
    // mapped agent (modeler-classic → 03_classic.md) with the file missing
    // → builder fallback instead of the old 404.
    arenaIds.reportMappedMissing = seedArena({
      round_number: 3, agent_name: "modeler-classic", val_metric: 0.78,
    });
    // FAILED arena contract breaks + a plain runtime crash — distinguishable
    // in the leaderboard via errorMessage / benchmarkExitCode.
    arenaIds.failedScriptMissing = seedArena({
      round_number: 4, agent_name: "modeler-classic", status: "FAILED",
      error_message: "[script_missing] agente não retornou script executável no JSON de resposta",
      benchmark_exit_code: -2,
    });
    arenaIds.failedAgentNoResponse = seedArena({
      round_number: 2, agent_name: "modeler-creative", status: "FAILED",
      error_message: "[agent_no_response] agente não respondeu dentro do timeout",
      benchmark_exit_code: -2,
    });
    arenaIds.failedRuntimeCrash = seedArena({
      round_number: 2, agent_name: "modeler-advanced", status: "FAILED",
      benchmark_exit_code: 1,
    });

    // Start server
    const started = await startDashboard();
    server = started.server;
    baseUrl = started.baseUrl;
  });

  after(async () => {
    await stopDashboard(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── /api/pipeline/status ────────────────────────────────────────

  it("GET /api/pipeline/status returns active pipeline info", async () => {
    const data = await fetchJSON(`${baseUrl}/api/pipeline/status`) as Record<string, unknown>;
    assert.equal(data.runId, "run-ml-001");
    assert.equal(data.status, "running");
    assert.equal(data.currentRound, 3);
    assert.equal(data.maxRounds, 5);
    const phaseStats = data.phaseStats as Record<string, string>;
    assert.ok(phaseStats);
    const quickStats = data.quickStats as Record<string, unknown>;
    assert.equal(quickStats.totalExperiments, 15);
    assert.ok(typeof quickStats.bestCvMean === "number");
  });

  // ── /api/agents ─────────────────────────────────────────────────

  it("GET /api/agents returns all 5 agents", async () => {
    const data = await fetchJSON(`${baseUrl}/api/agents`) as Array<Record<string, unknown>>;
    assert.equal(data.length, 5);
    const names = data.map((a) => a.name);
    assert.ok(names.includes("data-analyst"));
    assert.ok(names.includes("ml-critic"));
    // Each agent should have currentStatus field
    for (const agent of data) {
      assert.ok(typeof agent.currentStatus === "string");
    }
  });

  // ── /api/agents/:name ───────────────────────────────────────────

  it("GET /api/agents/:name returns agent detail", async () => {
    const data = await fetchJSON(`${baseUrl}/api/agents/modeler-classic`) as Record<string, unknown>;
    assert.equal((data.agent as Record<string, unknown>).name, "modeler-classic");
    assert.ok(typeof data.totalTrials === "number");
    assert.ok(Array.isArray(data.rounds));
    assert.ok((data.rounds as Array<unknown>).length >= 1);
  });

  it("GET /api/agents/:name returns 404 for unknown agent", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/nonexistent`);
    assert.equal(resp.status, 404);
  });

  // ── /api/agents/:name/logs ──────────────────────────────────────

  it("GET /api/agents/:name/logs returns paginated logs", async () => {
    const data = await fetchJSON(`${baseUrl}/api/agents/modeler-classic/logs?offset=0&limit=2`) as Record<string, unknown>;
    assert.equal(data.agentName, "modeler-classic");
    assert.ok(Array.isArray(data.entries));
    assert.ok((data.entries as Array<unknown>).length <= 2);
    assert.ok(typeof data.total === "number");
    assert.equal(data.offset, 0);
    assert.equal(data.limit, 2);
  });

  // ── /api/leaderboard ────────────────────────────────────────────

  it("GET /api/leaderboard returns ranked entries", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard`) as Record<string, unknown>;
    assert.ok(Array.isArray(data.entries));
    assert.ok(typeof data.total === "number");
    assert.ok(typeof data.bestCvMean === "number");
  });

  it("GET /api/leaderboard supports agentName filter", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard?agentName=modeler-classic`) as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    for (const entry of entries) {
      assert.equal(entry.agentName, "modeler-classic");
    }
  });

  it("GET /api/leaderboard supports roundNumber filter", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard?roundNumber=2`) as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    for (const entry of entries) {
      assert.equal(entry.roundNumber, 2);
    }
  });

  it("GET /api/leaderboard supports sortBy and sortDir", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard?sortBy=trainMean&sortDir=asc`) as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    assert.ok(entries.length > 0);
  });

  // ── /api/leaderboard/:id ────────────────────────────────────────

  it("GET /api/leaderboard/:id returns a single entry", async () => {
    const lb = await fetchJSON(`${baseUrl}/api/leaderboard`) as Record<string, unknown>;
    const first = (lb.entries as Array<Record<string, unknown>>)[0];
    const data = await fetchJSON(`${baseUrl}/api/leaderboard/${first.id}`) as Record<string, unknown>;
    assert.equal(data.id, first.id);
    assert.equal(data.modelId, first.modelId);
  });

  it("GET /api/leaderboard/:id returns 404 for missing id", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/99999`);
    assert.equal(resp.status, 404);
  });

  it("GET /api/leaderboard/:id returns 404 for invalid id", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/abc`);
    assert.equal(resp.status, 404);
  });

  // ── /api/leaderboard/:id/script (B1: artifact_script-first) ─────

  it("GET /api/leaderboard/:id/script serves the real arena script with preamble", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/${arenaIds.script}/script`);
    assert.equal(resp.status, 200);
    const data = await resp.json() as Record<string, unknown>;
    const script = data.script as string;
    assert.ok(script.includes("print(\"f1: 0.82\")"), "the real agent script body must be served");
    assert.match(script, /Generated by Formiga ML Pipeline/, "preamble must wrap the real script");
    assert.ok(!script.includes("pd.read_parquet(FEATURES_PATH)"), "template code must NOT be mixed in");
    assert.equal(data.filename, `reproduce_modeler_classic_${arenaIds.script}.py`);
    assert.equal(data.language, "python");
  });

  it("GET /api/leaderboard/:id/script falls back to the template without artifact_script", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/${arenaIds.scriptFallback}/script`);
    assert.equal(resp.status, 200);
    const data = await resp.json() as Record<string, unknown>;
    const script = data.script as string;
    assert.match(script, /Generated by Formiga ML Pipeline/);
    assert.ok(script.includes("pd.read_parquet(FEATURES_PATH)"), "template must be emitted when no real script exists");
    assert.ok(!script.includes("print(\"f1: 0.82\")"), "must not reference the other experiment's script");
    assert.equal(data.filename, `reproduce_lightgbm_${arenaIds.scriptFallback}.py`);
  });

  // ── /api/leaderboard/:id/report (C2: builder fallback, no 404) ──

  it("GET /api/leaderboard/:id/report builds a report for an unmapped arena agent", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/${arenaIds.reportBuilder}/report`);
    assert.equal(resp.status, 200);
    const data = await resp.json() as Record<string, unknown>;
    assert.equal(data.filename, `report_${arenaIds.reportBuilder}.md`);
    const content = data.content as string;
    assert.match(content, /## Resumo/);
    assert.ok(content.includes("Hipótese do criativo"), "hypothesis must render in the summary");
    assert.ok(content.includes("**Agent:** modeler-creative"));
    assert.match(content, /\*\*CV Mean \(f1\):\*\*/);
    assert.ok(content.includes("Top Features") || content.includes("feature_importances"), "rich features must be rendered when present");
  });

  it("GET /api/leaderboard/:id/report serves the mapped report file when present", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/${arenaIds.reportMapped}/report`);
    assert.equal(resp.status, 200);
    const data = await resp.json() as Record<string, unknown>;
    assert.equal(data.filename, "01_eda.md");
    assert.equal(data.content, "EDA MARKER CONTENT\n");
  });

  it("GET /api/leaderboard/:id/report falls back to the builder when the mapped file is missing", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/${arenaIds.reportMappedMissing}/report`);
    assert.equal(resp.status, 200, "mapped-but-missing must not 404");
    const data = await resp.json() as Record<string, unknown>;
    assert.equal(data.filename, `report_${arenaIds.reportMappedMissing}.md`);
    const content = data.content as string;
    assert.match(content, /## Resumo/);
    assert.ok(!content.includes("EDA MARKER CONTENT"), "must not serve a stale/wrong report");
  });

  // ── FAILED arena rows: distinguishable by reason (errorMessage/exit code)

  it("FAILED arena contract breaks surface errorMessage + benchmark_exit_code=-2", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard?runId=run-arena-int&status=FAILED`) as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    assert.ok(entries.length >= 3, "all seeded FAILED rows must appear");

    const byId = new Map(entries.map((e) => [String(e.id), e]));
    const scriptMissing = byId.get(String(arenaIds.failedScriptMissing));
    assert.ok(scriptMissing, "script_missing row present");
    assert.equal(scriptMissing.status, "FAILED");
    assert.equal(scriptMissing.benchmarkExitCode, -2);
    assert.match(scriptMissing.errorMessage as string, /\[script_missing\]/);

    const agentNoResponse = byId.get(String(arenaIds.failedAgentNoResponse));
    assert.ok(agentNoResponse, "agent_no_response row present");
    assert.equal(agentNoResponse.status, "FAILED");
    assert.equal(agentNoResponse.benchmarkExitCode, -2);
    assert.match(agentNoResponse.errorMessage as string, /\[agent_no_response\]/);

    const runtimeCrash = byId.get(String(arenaIds.failedRuntimeCrash));
    assert.ok(runtimeCrash, "runtime-crash row present");
    assert.equal(runtimeCrash.status, "FAILED");
    assert.equal(runtimeCrash.benchmarkExitCode, 1, "a real crash keeps its exit code");
    assert.equal(runtimeCrash.errorMessage, null, "a plain crash has no contract-break message");
  });

  it("FAILED rows are distinguishable from a successful run in the same list", async () => {
    const data = await fetchJSON(`${baseUrl}/api/leaderboard?runId=run-arena-int`) as Record<string, unknown>;
    const entries = data.entries as Array<Record<string, unknown>>;
    const success = entries.find((e) => e.id === String(arenaIds.script));
    assert.ok(success, "the seeded success row is listed");
    assert.notEqual(success.status, "FAILED");
    assert.equal(success.benchmarkExitCode, null);
    assert.equal(success.errorMessage, null);
  });

  // ── /api/leaderboard/compare ────────────────────────────────────

  it("GET /api/leaderboard/compare requires at least 2 ids", async () => {
    const resp = await fetch(`${baseUrl}/api/leaderboard/compare?id=1`);
    assert.equal(resp.status, 400);
  });

  it("GET /api/leaderboard/compare returns entries for valid ids", async () => {
    const lb = await fetchJSON(`${baseUrl}/api/leaderboard`) as Record<string, unknown>;
    const entries = lb.entries as Array<Record<string, unknown>>;
    if (entries.length >= 2) {
      const resp = await fetch(`${baseUrl}/api/leaderboard/compare?id=${entries[0].id}&id=${entries[1].id}`);
      assert.equal(resp.status, 200);
      const data = await resp.json() as Record<string, unknown>;
      assert.ok(Array.isArray(data.entries));
      assert.equal((data.entries as Array<unknown>).length, 2);
    }
  });

  // ── /api/rounds ─────────────────────────────────────────────────

  it("GET /api/rounds returns round summaries", async () => {
    const data = await fetchJSON(`${baseUrl}/api/rounds?runId=run-ml-001`) as Array<Record<string, unknown>>;
    assert.equal(data.length, 3);
    for (const round of data) {
      assert.ok(typeof round.roundNumber === "number");
      assert.ok(typeof round.experimentsRegistered === "number");
    }
  });

  // ── /api/cross-findings ─────────────────────────────────────────

  it("GET /api/cross-findings returns cross-modeler comparisons", async () => {
    const data = await fetchJSON(`${baseUrl}/api/cross-findings?runId=run-ml-001`) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(data));
    // Should have findings for rounds where both modelers produced results
    for (const finding of data) {
      assert.ok(typeof finding.roundNumber === "number");
      assert.ok(typeof finding.content === "string");
    }
  });

  // ── /api/pipeline/control ───────────────────────────────────────

  it("POST /api/pipeline/pause returns 502 when daemon unavailable", async () => {
    const resp = await fetch(`${baseUrl}/api/pipeline/pause`, { method: "POST" });
    // 502 = Daemon unreachable (no daemon running in tests, but run exists)
    assert.equal(resp.status, 502);
  });

  it("POST /api/pipeline/cancel returns 500 or 200 depending on daemon", async () => {
    const resp = await fetch(`${baseUrl}/api/pipeline/cancel`, { method: "POST" });
    // 500 = stopWorkflow fails without daemon, 200 = success
    assert.ok(resp.status === 500 || resp.status === 200);
  });

  // ── /api/pipeline/status when idle ──────────────────────────────

  it("returns idle state when no active pipeline", async () => {
    // Create a temp server with no seeded experiments
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-ml-api-idle-"));
    const homeDir2 = path.join(root2, "home");
    const dbPath2 = path.join(homeDir2, ".formiga", "formiga.db");
    fs.mkdirSync(path.dirname(dbPath2), { recursive: true });

    const prevHome = process.env.HOME;
    const prevDb = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir2;
    process.env.FORMIGA_DB_PATH = dbPath2;

    try {
      const db2 = new DatabaseSync(dbPath2);
      initLeaderboardSchema(db2);
      db2.close();

      const { server: svr, baseUrl: url } = await startDashboard();
      try {
        const data = await fetchJSON(`${url}/api/pipeline/status`) as Record<string, unknown>;
        assert.equal(data.runId, null);
        assert.equal(data.status, "idle");
        assert.equal(data.currentPhase, "idle");
        assert.equal(data.currentRound, 0);
      } finally {
        await stopDashboard(svr);
      }
    } finally {
      process.env.HOME = prevHome;
      process.env.FORMIGA_DB_PATH = prevDb;
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

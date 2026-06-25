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

function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createDashboardServer(0);
    server.on("listening", () => {
      const addr = server.address();
      assert.ok(addr && typeof addr !== "string");
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
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

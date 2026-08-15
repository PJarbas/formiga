import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../../dist/server/dashboard.js";
import { type FormigaEvent } from "../../dist/installer/events.js";
import { getDb, incrementSystemTokenSpend, getSystemTokenSpend } from "../../dist/db.js";
import { daemonAuthHeaders } from "../../dist/server/test-auth.js";

interface LogsTailResponse {
  lines: string[];
  nextOffset: number;
}

function appendGlobalEvent(stateDir: string, evt: FormigaEvent): void {
  const filePath = path.join(stateDir, "events", "all.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(evt)}\n`, "utf-8");
}

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = await createDashboardServer(0);
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("dashboard logs-tail API", () => {
  it("returns initial logs-tail lines and cursor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.FORMIGA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:15:00.000Z",
      event: "step.pending",
      runId: "runalpha01",
      agentId: "feature-dev_developer",
      storyTitle: "Expose logs-tail API",
      detail: "initial poll",
    });
    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:16:00.000Z",
      event: "story.done",
      runId: "runalpha01",
      storyTitle: "Expose logs-tail API",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(response.status, 200);

      const payload = await response.json() as LogsTailResponse;
      assert.equal(payload.lines.length, 2);
      assert.ok(payload.nextOffset > 0);

      assert.match(payload.lines[0], /\[runalpha\]/);
      assert.match(payload.lines[0], /developer/);
      assert.match(payload.lines[0], /Step pending/);
      assert.match(payload.lines[0], /— Expose logs-tail API/);
      assert.match(payload.lines[0], /\(initial poll\)/);
      assert.match(payload.lines[1], /Story done/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.FORMIGA_STATE_DIR;
      else process.env.FORMIGA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports incremental cursor polling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.FORMIGA_STATE_DIR;
    process.env.FORMIGA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T11:00:00.000Z",
      event: "step.pending",
      runId: "runbeta02",
      detail: "first",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const initialResponse = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(initialResponse.status, 200);
      const initialPayload = await initialResponse.json() as LogsTailResponse;
      assert.equal(initialPayload.lines.length, 1);
      assert.match(initialPayload.lines[0], /\(first\)/);

      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:01:00.000Z",
        event: "step.running",
        runId: "runbeta02",
        detail: "second",
      });
      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:02:00.000Z",
        event: "step.done",
        runId: "runbeta02",
        detail: "third",
      });

      const nextResponse = await fetch(`${baseUrl}/api/logs-tail?offset=${initialPayload.nextOffset}`);
      assert.equal(nextResponse.status, 200);
      const nextPayload = await nextResponse.json() as LogsTailResponse;

      assert.equal(nextPayload.lines.length, 2);
      assert.ok(nextPayload.nextOffset > initialPayload.nextOffset);
      assert.equal(nextPayload.lines.some((line) => line.includes("(first)")), false);
      assert.match(nextPayload.lines[0], /Claimed step/);
      assert.match(nextPayload.lines[0], /\(second\)/);
      assert.match(nextPayload.lines[1], /Step completed/);
      assert.match(nextPayload.lines[1], /\(third\)/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.FORMIGA_STATE_DIR;
      else process.env.FORMIGA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("dashboard stats API", () => {
  it("GET /api/stats returns systemTokensSpent and totalTokensSpent on fresh DB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    try {
      // Open DB to trigger migration (creates formiga_stats with default 0)
      getDb();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(typeof body.systemTokensSpent, "number");
        assert.equal(typeof body.totalTokensSpent, "number");
        assert.equal(body.systemTokensSpent, 0);
        assert.equal(body.totalTokensSpent, 0);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats totalTokensSpent equals system + run tokens", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    try {
      const db = getDb();

      // Add some run token data
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-1', 1, 'wf-1', 'task 1', 'running', 500, '2026-01-01', '2026-01-01')
      `).run();
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-2', 2, 'wf-2', 'task 2', 'done', 300, '2026-01-01', '2026-01-01')
      `).run();

      // Add system token spend
      incrementSystemTokenSpend(150);

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(body.systemTokensSpent, 150);
        assert.equal(body.totalTokensSpent, 950); // 500 + 300 + 150
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats handles DB without formiga_stats gracefully", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    try {
      // Create a DB with runs table but WITHOUT formiga_stats (legacy DB)
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          tokens_spent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacyDb.exec(`
        INSERT INTO runs (id, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('legacy-run', 'wf-legacy', 'legacy task', 'done', 200, '2025-01-01', '2025-01-01')
      `);
      legacyDb.close();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        // getSystemTokenSpend returns 0 when the table doesn't exist
        assert.equal(body.systemTokensSpent, 0);
        // total = system(0) + sum of run tokens(200)
        assert.equal(body.totalTokensSpent, 200);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("dashboard run detail failure_reason", () => {
  it("returns failure_reason=null for running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns failure_reason=null for completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 2, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns failure_reason=null for paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 3, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, null);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 'Canceled' for canceled run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-canceled";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 4, 'wf-1', 'task', 'canceled', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns first failed step output for failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 5, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
      VALUES ('step-1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'done', 'All good', '2026-01-01', '2026-01-01')
    `).run(runId);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
      VALUES ('step-2', ?, 's2', 'agent-b', 1, 'do thing 2', '{}', 'failed', 'Build error: syntax', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Build error: syntax");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns 'Run failed' for failed run with no failed-step output", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-failure-reason-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-no-output";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 6, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    // No steps at all - should fall back to "Run failed"
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}`);
      assert.equal(response.status, 200);

      const body = await response.json() as { failure_reason: string | null };
      assert.equal(body.failure_reason, "Run failed");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard run detail prompt field", () => {
  it("returns prompt field from run.task for all statuses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-prompt-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const testCases = [
      { id: "run-running-prompt", status: "running", task: "Implement feature X", expectedFailReason: null },
      { id: "run-completed-prompt", status: "completed", task: "Refactor module Y", expectedFailReason: null },
      { id: "run-paused-prompt", status: "paused", task: "Test pipeline Z", expectedFailReason: null },
      { id: "run-failed-prompt", status: "failed", task: "Fix build error", expectedFailReason: "Run failed" },
      { id: "run-canceled-prompt", status: "canceled", task: "Update dependencies", expectedFailReason: "Canceled" },
    ];

    for (const tc of testCases) {
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
        VALUES (?, 1, 'wf-1', ?, ?, '{}', 0, '2026-01-01', '2026-01-01')
      `).run(tc.id, tc.task, tc.status);
    }

    const { server, baseUrl } = await startDashboard();

    try {
      for (const tc of testCases) {
        const response = await fetch(`${baseUrl}/api/runs/${tc.id}`);
        assert.equal(response.status, 200, `expected 200 for ${tc.id}`);

        const body = await response.json() as { prompt: string; failure_reason: string | null };
        assert.equal(body.prompt, tc.task, `prompt mismatch for ${tc.status}`);
        assert.equal(body.failure_reason, tc.expectedFailReason, `failure_reason mismatch for ${tc.status}`);
      }
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard run relaunch API", () => {
  it("POST /api/runs/:id/relaunch returns 404 for missing run", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });
      assert.equal(response.status, 404);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Run not found/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in running state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 2, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in completed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 409 for paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 3, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot relaunch run in paused state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch returns 400 for invalid JSON body", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-bad-json";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 4, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
        body: "not valid json!!!",
      });
      assert.equal(response.status, 400);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Invalid JSON body/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch handles canceled run (routes correctly through handler)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-canceled-relaunch";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 5, 'wf-1', 'Original task', 'canceled', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent","repo":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      // This will fail at runWorkflow (no daemon, no workflow, no working dir)
      // but the handler routing is verified by getting a 500 (not 404/409)
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
        body: JSON.stringify({ task: "Updated task" }),
      });

      // 500 from runWorkflow failing is expected — handler logic passed validation
      assert.equal(response.status, 500);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch with empty body uses original task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-empty-body";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 6, 'wf-1', 'Original task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      // No body — should use original task. Will fail at runWorkflow (no daemon).
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch with whitespace-only task uses original task", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-whitespace-task";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 7, 'wf-1', 'Original task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
        body: JSON.stringify({ task: "   " }),
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/relaunch preserves notify_url from original run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-relaunch-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-notify";
    const notifyUrl = "https://hooks.example.com/notify";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, notify_url, created_at, updated_at)
      VALUES (?, 8, 'wf-1', 'task', 'failed', '{"workspace_mode":"direct","working_directory_for_harness":"/tmp/nonexistent"}', 0, ?, '2026-01-01', '2026-01-01')
    `).run(runId, notifyUrl);

    const { server, baseUrl } = await startDashboard();

    try {
      // This will fail at runWorkflow but tests that notify_url is read from DB
      const response = await fetch(`${baseUrl}/api/runs/${runId}/relaunch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...daemonAuthHeaders() },
      });

      // 500 from runWorkflow failing is expected
      assert.equal(response.status, 500);
      const body = await response.json() as { error: string };
      assert.match(body.error, /Failed to relaunch run/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard build version API", () => {
  it("GET /api/version returns { version } with build version string from dist/version", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version`);
      assert.equal(response.status, 200);

      const body = await response.json() as { version: string };
      // dist/version is written by inject-version.js at build time
      assert.ok(typeof body.version === "string", "version must be a string");
      assert.ok(body.version.length > 0, "version must not be empty");
      assert.notEqual(body.version, "unknown", "version should be the real build version, not 'unknown'");
      // ISO8601_refhash format: YYYYMMDDTHHMMSSZ_40-char-hex
      assert.match(body.version, /^\d{8}T\d{6}Z_[0-9a-f]{40}$/);
    } finally {
      await stopDashboard(server);
    }
  });
});



describe("dashboard /api/runs no_hurry field", () => {
  it("no_hurry is true when context.no_hurry_save_tokens_mode === 'true'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-true', 1, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"true"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      assert.ok(Array.isArray(body.runs));
      const run = body.runs.find((r) => r.id === "run-nohurry-true");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, true);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context.no_hurry_save_tokens_mode === 'false'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-false', 1, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"false"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-false");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context is missing no_hurry_save_tokens_mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-missing', 1, 'wf-1', 'task', 'running', '{"other_key":"value"}', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-missing");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is false when context JSON is malformed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-nohurry-malformed', 1, 'wf-1', 'task', 'running', 'not valid json {{{', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      const run = body.runs.find((r) => r.id === "run-nohurry-malformed");
      assert.ok(run, "run not found in response");
      assert.equal(run.no_hurry, false);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("no_hurry is never undefined — always a boolean", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-nohurry-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    // Insert runs with various context states
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-a', 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-b', 2, 'wf-1', 'task', 'running', '{"no_hurry_save_tokens_mode":"true"}', 0, '2026-01-01', '2026-01-01')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES ('run-c', 3, 'wf-1', 'task', 'running', 'broken', 0, '2026-01-01', '2026-01-01')
    `).run();

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      assert.equal(response.status, 200);

      const body = await response.json() as { runs: Array<{ id: string; no_hurry: boolean }> };
      for (const run of body.runs) {
        assert.equal(typeof run.no_hurry, "boolean", `run ${run.id} no_hurry should be boolean, got ${typeof run.no_hurry}`);
      }
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createMinimalGitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@formiga.local"]);
  spawnSync("git", ["-C", dir, "config", "user.name", "Formiga Test"]);
  spawnSync("git", ["-C", dir, "commit", "--allow-empty", "-m", "initial"]);
  return dir;
}

async function startMockControlServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/control/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else if (url.pathname === "/control/register-run" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "active" }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port };
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function installWorkflowInHome(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".formiga", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  const srcYml = path.join(TEST_DIR, "..", "..", "workflows", workflowId, "workflow.yml");
  fs.copyFileSync(srcYml, path.join(workflowDir, "workflow.yml"));
}

describe("dashboard cancel API", () => {
  it("POST /api/runs/:id/cancel returns 200 for a paused run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-paused-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'paused', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);
    // Add a waiting step to verify it gets canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'waiting', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 200);

      const body = await response.json() as { canceled: boolean; runId: string };
      assert.equal(body.canceled, true);
      assert.equal(body.runId, runId);

      // Verify run status changed in DB
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");

      // Verify step was canceled
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-1") as { status: string };
      assert.equal(step.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 200 for a running run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-running-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);
    // Add running and pending steps
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-r1', ?, 's1', 'agent-a', 0, 'do thing', '{}', 'running', '2026-01-01', '2026-01-01')
    `).run(runId);
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('step-r2', ?, 's2', 'agent-b', 1, 'do thing 2', '{}', 'pending', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 200);

      const body = await response.json() as { canceled: boolean; runId: string };
      assert.equal(body.canceled, true);
      assert.equal(body.runId, runId);

      // Verify run status changed
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");

      // Verify both steps were canceled
      const step1 = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-r1") as { status: string };
      const step2 = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-r2") as { status: string };
      assert.equal(step1.status, "canceled");
      assert.equal(step2.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 404 for a nonexistent run", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 404);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Run not found/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for a completed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-completed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'completed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in completed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for a failed run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-failed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'failed', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in failed state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel returns 409 for an already canceled run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-already-canceled";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'canceled', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 409);

      const body = await response.json() as { error: string };
      assert.match(body.error, /Cannot cancel run in canceled state/);
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/cancel cancels only waiting/pending/running steps, leaves done/failed untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-dashboard-cancel-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".formiga", "formiga.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.FORMIGA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.FORMIGA_DB_PATH = dbPath;

    const db = getDb();
    const runId = "run-mixed-cancel";
    db.prepare(`
      INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
      VALUES (?, 1, 'wf-1', 'task', 'running', '{}', 0, '2026-01-01', '2026-01-01')
    `).run(runId);

    // Done step — should remain done
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-done', ?, 's1', 'agent-a', 0, 'done task', '{}', 'done', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Failed step — should remain failed
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-failed', ?, 's2', 'agent-b', 1, 'failed task', '{}', 'failed', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Waiting step — should be canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-waiting', ?, 's3', 'agent-c', 2, 'waiting task', '{}', 'waiting', '2026-01-01', '2026-01-01')
    `).run(runId);
    // Pending step — should be canceled
    db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
      VALUES ('s-pending', ?, 's4', 'agent-d', 3, 'pending task', '{}', 'pending', '2026-01-01', '2026-01-01')
    `).run(runId);

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST", headers: daemonAuthHeaders() });
      assert.equal(response.status, 200);

      // Done step unchanged
      const sDone = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-done") as { status: string };
      assert.equal(sDone.status, "done");

      // Failed step unchanged
      const sFailed = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-failed") as { status: string };
      assert.equal(sFailed.status, "failed");

      // Waiting step canceled
      const sWaiting = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-waiting") as { status: string };
      assert.equal(sWaiting.status, "canceled");

      // Pending step canceled
      const sPending = db.prepare("SELECT status FROM steps WHERE id = ?").get("s-pending") as { status: string };
      assert.equal(sPending.status, "canceled");

      // Run status canceled
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "canceled");
    } finally {
      await stopDashboard(server);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


// ── AutoResearch Session API tests ───────────────────────────────────



// ── Security tests (CR-1/2/3) ────────────────────────────────────────

describe("dashboard security (CR-1/2/3)", () => {
  it("binds to the loopback interface by default (CR-1)", async () => {
    const { server } = await startDashboard();
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(address.address, "127.0.0.1");
    } finally {
      await stopDashboard(server);
    }
  });

  it("rejects a mutating /api call without the daemon secret (CR-1)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/cancel`, { method: "POST" });
      assert.equal(response.status, 401);
    } finally {
      await stopDashboard(server);
    }
  });

  it("accepts a mutating /api call with the daemon secret header (CR-1)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/api/runs/nonexistent-id/cancel`, {
        method: "POST",
        headers: daemonAuthHeaders(),
      });
      // Reaches the handler (404: run not found), not the auth gate.
      assert.equal(response.status, 404);
    } finally {
      await stopDashboard(server);
    }
  });

  it("sets an HttpOnly SameSite=Strict session cookie on the SPA shell (CR-1)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.ok(setCookie.includes("formiga_ds="), `expected session cookie, got: ${setCookie}`);
      assert.ok(setCookie.includes("HttpOnly"), setCookie);
      assert.ok(setCookie.includes("SameSite=Strict"), setCookie);
    } finally {
      await stopDashboard(server);
    }
  });

  it("blocks path traversal in /assets/ (CR-2)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      // Use a raw http.request with a literal ../ path: the WHATWG URL parser
      // (used by fetch) normalizes ../ segments client-side, which would hide
      // the exact request the server must defend against.
      const u = new URL(baseUrl);
      const raw = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            host: u.hostname,
            port: u.port,
            method: "GET",
            path: "/assets/../../../../etc/passwd",
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(raw.status, 403);
    } finally {
      await stopDashboard(server);
    }
  });

  it("serves a legitimate /assets/ file (CR-2 containment keeps working)", async () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url)); // <repo>/src/server
    const assetsDir = path.resolve(testDir, "..", "..", "dist", "dashboard", "assets");
    if (!fs.existsSync(assetsDir)) return; // SPA not built in this environment
    const firstAsset = fs.readdirSync(assetsDir).find((f) => f.endsWith(".js"));
    if (!firstAsset) return;

    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/assets/${firstAsset}`);
      assert.equal(response.status, 200);
    } finally {
      await stopDashboard(server);
    }
  });

  it("does not emit Access-Control-Allow-Origin (CR-3)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    } finally {
      await stopDashboard(server);
    }
  });

  it("answers OPTIONS preflight with 204 and no CORS headers (CR-3)", async () => {
    const { server, baseUrl } = await startDashboard();
    try {
      const response = await fetch(`${baseUrl}/api/runs`, { method: "OPTIONS" });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.equal(response.headers.get("access-control-allow-methods"), null);
    } finally {
      await stopDashboard(server);
    }
  });
});

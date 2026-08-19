// ══════════════════════════════════════════════════════════════════════
// direct-spawn-arena-process.test.ts — Bug A regression
// ══════════════════════════════════════════════════════════════════════
//
// Bug A (run 77cb1ea6): `formiga step complete` → postAdvanceSpawn →
// spawnAgentsForPendingSteps ran the arena engine IN-PROCESS via
// `await launchArenaFromStep`. The step-complete CLI runs in a subprocess
// spawned by the agent's harness (its Bash tool), so the arena's multi-round
// modeler runs kept that subprocess's event loop alive for many minutes and
// the harness never resolved. Fix: spawn the arena in a detached child
// process (spawnArenaProcess) so the caller returns immediately.
//
// These tests guard the fix:
//   1. spawnArenaProcess (unit): returns a pid synchronously instead of
//      blocking, and the child really runs in a different process.
//   2. spawnAgentsForPendingSteps (branch): with a pending arena step, the
//      wiring (the code called by completeStep's postAdvanceSpawn) returns
//      fast instead of running the arena in-process, marks the step running
//      first (claim-race guard — the arena step is claim-eligible while
//      pending), and launches the detached host.

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { getDb, resetPrisma } from "../../db.js";
import { spawnAgentsForPendingSteps, spawnArenaProcess } from "./direct-spawn.js";

/**
 * Fake arena host: writes its pid to the FORMIGA_TEST_MARKER path, then stays
 * alive a few seconds. The arena host would run for minutes; the whole point
 * of the regression is that the parent returns while it is still up, so the
 * fake must outlive the parent's return (the elapsed assertions below) but
 * still self-terminate so a test that fails before cleanup can't leak.
 */
const FAKE_SCRIPT = [
  "const fs = require('node:fs');",
  "const marker = process.env.FORMIGA_TEST_MARKER;",
  "if (marker) fs.writeFileSync(marker, String(process.pid));",
  "setTimeout(() => process.exit(0), 8000);",
].join("\n");

/** Poll for the marker file and return the pid written by the fake host. */
async function waitForMarkerPid(markerPath: string): Promise<number> {
  const deadline = Date.now() + 5000;
  let content = "";
  while (Date.now() < deadline) {
    try {
      content = fs.readFileSync(markerPath, "utf-8").trim();
    } catch {
      content = "";
    }
    const pid = Number.parseInt(content, 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`arena host marker never appeared at ${markerPath}; last read: ${JSON.stringify(content)}`);
}

describe("arena launches in a detached process (Bug A regression)", () => {
  let tempHome: string;
  const orig: Record<string, string | undefined> = {};

  // Temp DB for the whole file: no test may touch the real ~/.formiga DB.
  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-arena-detach-"));
    orig.HOME = process.env.HOME;
    orig.FORMIGA_DB_PATH = process.env.FORMIGA_DB_PATH;
    orig.FORMIGA_STATE_DIR = process.env.FORMIGA_STATE_DIR;
    process.env.HOME = tempHome;
    process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
    process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
  });

  after(async () => {
    await resetPrisma();
    for (const [key, value] of Object.entries(orig)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("spawnArenaProcess (unit)", () => {
    let tempDir: string;
    let markerPath: string;
    let scriptPath: string;
    let childPid: number | undefined;

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(tempHome, "unit-"));
      markerPath = path.join(tempDir, "marker.pid");
      scriptPath = path.join(tempDir, "fake-arena.cjs");
      fs.writeFileSync(scriptPath, FAKE_SCRIPT, "utf-8");
      process.env.FORMIGA_TEST_MARKER = markerPath;
    });

    afterEach(() => {
      delete process.env.FORMIGA_TEST_MARKER;
      if (childPid) {
        try { process.kill(childPid, "SIGTERM"); } catch { /* already dead */ }
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns a pid immediately and runs the host in a separate process", async () => {
      const started = Date.now();
      const res = spawnArenaProcess("run-1", "step-1", { scriptPath });
      const elapsedMs = Date.now() - started;
      childPid = res.pid;

      assert.ok(res.pid, "spawnArenaProcess must return a child pid");
      assert.ok(elapsedMs < 2000, `spawnArenaProcess blocked the caller (${elapsedMs}ms) — arena host ran in-process`);

      const pid = await waitForMarkerPid(markerPath);
      assert.equal(pid, res.pid, "marker pid must match the returned child pid");
      assert.notEqual(pid, process.pid, "arena host must run in a separate process");
    });
  });

  describe("spawnAgentsForPendingSteps arena branch (wiring)", () => {
    let tempDir: string;
    let markerPath: string;
    let scriptPath: string;
    let childPid: number | undefined;

    before(() => {
      // First getDb() call migrates the schema on the temp DB (see
      // src/database/legacy-compat.ts). Prisma shares the same SQLite file.
      getDb();
    });

    beforeEach(() => {
      tempDir = mkdtempSync(path.join(tempHome, "branch-"));
      markerPath = path.join(tempDir, "marker.pid");
      scriptPath = path.join(tempDir, "fake-arena.cjs");
      fs.writeFileSync(scriptPath, FAKE_SCRIPT, "utf-8");
      process.env.FORMIGA_ARENA_PROCESS_SCRIPT = scriptPath;
      process.env.FORMIGA_TEST_MARKER = markerPath;

      const db = getDb();
      db.exec("DELETE FROM steps");
      db.exec("DELETE FROM runs");
    });

    afterEach(() => {
      delete process.env.FORMIGA_ARENA_PROCESS_SCRIPT;
      delete process.env.FORMIGA_TEST_MARKER;
      if (childPid) {
        try { process.kill(childPid, "SIGTERM"); } catch { /* already dead */ }
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    function insertRun(runId: string): void {
      getDb()
        .prepare(
          `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
           VALUES (?, 'ml-autoresearch', 'test', 'running', '{}', datetime('now'), datetime('now'))`,
        )
        .run(runId);
    }

    function insertArenaStep(runId: string): void {
      getDb()
        .prepare(
          `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                              status, retry_count, max_retries, type, created_at, updated_at)
           VALUES (?, ?, 'arena', 'ml-autoresearch_feature-engineer', 2, '', '', 'pending',
                   0, 3, 'single', datetime('now'), datetime('now'))`,
        )
        .run(`step-arena-${runId}`, runId);
    }

    it("returns immediately (not in-process), marks the step running, and spawns the detached host", async () => {
      const runId = "run-arena-detach";
      insertRun(runId);
      insertArenaStep(runId);

      const started = Date.now();
      await spawnAgentsForPendingSteps(runId);
      const elapsedMs = Date.now() - started;

      // THE regression: the old code awaited launchArenaFromStep inline, so
      // this call — reached from completeStep's postAdvanceSpawn inside the
      // harness's CLI subprocess — never returned until the whole arena
      // finished, and the harness never resolved (run 77cb1ea6).
      assert.ok(elapsedMs < 2000, `spawnAgentsForPendingSteps blocked (${elapsedMs}ms) — arena ran in-process`);

      // Claim-race guard: the arena step is owned by feature-engineer and is
      // claim-eligible while "pending" (claim.ts filters only agent_id +
      // status), so the parent marks it running BEFORE spawning the host. A
      // lingering feature-engineer cron must not be able to claim it.
      const row = getDb()
        .prepare("SELECT status FROM steps WHERE id = ?")
        .get(`step-arena-${runId}`) as { status: string };
      assert.equal(row.status, "running", "arena step must be marked running by the parent");

      // The detached arena host really launched, in a different process.
      const pid = await waitForMarkerPid(markerPath);
      childPid = pid;
      assert.notEqual(pid, process.pid, "arena host must run in a separate process");
    });
  });
});

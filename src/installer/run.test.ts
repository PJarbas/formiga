import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { runWorkflow } from "../../dist/installer/run.js";
import { getPidFile, getPortFile, stopDaemon } from "../../dist/server/daemonctl.js";
import { reserveRandomPort } from "../../tests/helpers/test-env.ts";

// ── Helpers ──

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(["init", "--initial-branch=main"], dir);
  runGit(["config", "user.email", "test@tamandua.local"], dir);
  runGit(["config", "user.name", "Tamandua Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf-8");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial commit"], dir);
}


function readPid(filePath: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(filePath, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function writeMinimalWorkflow(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(path.join(workflowDir, "workflow.yml"),
    `id: ${workflowId}\nrun:\n  workspace: direct\nagents:\n  - id: dev\n    model: fake\n    workspace:\n      baseDir: .\nsteps:\n  - id: implement\n    agent: dev\n    input: Implement the task\n    expects: STATUS, CHANGES, TESTS\n`,
    "utf-8");
}

// ── Test suite ──

describe("runWorkflow", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origControlPort: string | undefined;
  let origDbPath: string | undefined;
  let origStateDir: string | undefined;

  before(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-run-"));
    origHome = process.env.HOME;
    origControlPort = process.env.TAMANDUA_CONTROL_PORT;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    origStateDir = process.env.TAMANDUA_STATE_DIR;

    const tamanduaDir = path.join(tempHome, ".tamandua");
    const dashboardPort = await reserveRandomPort();
    let controlPort = await reserveRandomPort();
    while (controlPort === dashboardPort) {
      controlPort = await reserveRandomPort();
    }
    fs.mkdirSync(tamanduaDir, { recursive: true });
    fs.writeFileSync(path.join(tamanduaDir, "port"), String(dashboardPort), "utf-8");

    process.env.HOME = tempHome;
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);
    process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
    process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  });

  after(async () => {
    const pid = readPid(getPidFile({ homeDir: tempHome }));
    try { stopDaemon({ homeDir: tempHome }); } catch {}
    if (pid !== null) await waitForPidExit(pid);

    if (origHome !== undefined) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = origControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }
    if (origDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    if (origStateDir !== undefined) {
      process.env.TAMANDUA_STATE_DIR = origStateDir;
    } else {
      delete process.env.TAMANDUA_STATE_DIR;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("daemonctl paths honor HOME assigned after module import", () => {
    assert.ok(getPidFile().startsWith(tempHome));
    assert.ok(getPortFile().startsWith(tempHome));
  });

  describe("working directory validation", () => {
    it("rejects when working directory exists but is a file, not a directory", async () => {
      const workflowId = "test-wd-file";
      writeMinimalWorkflow(tempHome, workflowId);
      const filePath = path.join(tempHome, "test-workdir-file");
      fs.writeFileSync(filePath, "not a directory", "utf-8");

      await assert.rejects(
        runWorkflow({
          workflowId,
          taskTitle: "Test working directory is a file",
          workingDirectoryForHarness: filePath,
        }),
        /working-directory-for-harness must be a directory/,
      );
    });
  });

  describe("runWorkflow context seeding", () => {
    it("stores no_hurry_save_tokens_mode as 'false' when flag is not provided", async () => {
      const workflowId = "test-ctx-default";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({ workflowId, taskTitle: "Test default save tokens flag" });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_hurry_save_tokens_mode, "false");
    });

    it("stores no_hurry_save_tokens_mode as 'true' when flag is true", async () => {
      const workflowId = "test-ctx-true";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test save tokens flag true",
          noHurrySaveTokensMode: true,
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_hurry_save_tokens_mode, "true");
    });

    it("stores no_hurry_save_tokens_mode as 'false' when flag is explicitly false", async () => {
      const workflowId = "test-ctx-false";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test save tokens flag false",
          noHurrySaveTokensMode: false,
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_hurry_save_tokens_mode, "false");
    });

    it("includes other context keys alongside no_hurry_save_tokens_mode", async () => {
      const workflowId = "test-ctx-combined";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test combined context",
          noHurrySaveTokensMode: true,
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_hurry_save_tokens_mode, "true");
      assert.equal(ctx.task, "Test combined context");
      assert.equal(ctx.workspace_mode, "direct");
    });

    // ── Harness type context tests ──

    it("stores harness_type 'pi' by default when harnessType is not provided", async () => {
      const workflowId = "test-ctx-harness-default";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test default harness type context",
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "pi");
    });

    it("stores harness_type 'hermes' when harnessType is explicitly 'hermes'", async () => {
      const workflowId = "test-ctx-harness-hermes";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test hermes harness type context",
          harnessType: "hermes",
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "hermes");
    });

    it("stores harness_type 'pi' when harnessType is explicitly 'pi'", async () => {
      const workflowId = "test-ctx-harness-explicit-pi";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test explicit pi harness type context",
          harnessType: "pi",
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "pi");
    });

    // ── base_branch_sha context tests ──

    it("stores base_branch_sha from git rev-parse for direct mode", async () => {
      const workflowId = "test-ctx-bbsha-direct";
      writeMinimalWorkflow(tempHome, workflowId);
      const repoDir = path.join(tempHome, "test-repo-direct");
      initGitRepo(repoDir);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test base_branch_sha in direct mode",
          workingDirectoryForHarness: repoDir,
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.ok(ctx.base_branch_sha, "base_branch_sha should be present");
      assert.equal(typeof ctx.base_branch_sha, "string");
      assert.ok(ctx.base_branch_sha.length === 40, "base_branch_sha should be a full 40-char SHA");
      assert.match(ctx.base_branch_sha, /^[0-9a-f]{40}$/);
    });

    it("stores base_branch_sha as empty string when git rev-parse fails in direct mode", async () => {
      const workflowId = "test-ctx-bbsha-empty";
      writeMinimalWorkflow(tempHome, workflowId);
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-non-git-sha-"));

      try {
        try {
          await runWorkflow({
            workflowId,
            taskTitle: "Test base_branch_sha empty on git failure",
            workingDirectoryForHarness: nonGitDir,
          });
        } catch {
          // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
        }

        const { getDb } = await import("../../dist/db.js");
        const db = getDb();
        const rows = db.prepare(
          "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
        ).all(workflowId) as { context: string }[];
        assert.ok(rows.length > 0, "run record should exist");
        const ctx = JSON.parse(rows[0].context);
        assert.equal(ctx.base_branch_sha, "",
          "base_branch_sha should be empty string when git rev-parse fails");
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it("stores harness_type alongside other context fields", async () => {
      const workflowId = "test-ctx-harness-combined";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test harness with other context",
          noHurrySaveTokensMode: true,
          harnessType: "hermes",
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.harness_type, "hermes");
      assert.equal(ctx.no_hurry_save_tokens_mode, "true");
      assert.equal(ctx.task, "Test harness with other context");
      assert.equal(ctx.workspace_mode, "direct");
    });

    it("stores no_relaunch_upon_rugpull as 'true' when flag is set", async () => {
      const workflowId = "test-ctx-norelaunch";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test no_relaunch_upon_rugpull context",
          noRelaunchUponRugpull: true,
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_relaunch_upon_rugpull, "true",
        "no_relaunch_upon_rugpull should be 'true' when flag is set");
    });

    it("stores no_relaunch_upon_rugpull as 'false' when flag is not set", async () => {
      const workflowId = "test-ctx-norelaunch-default";
      writeMinimalWorkflow(tempHome, workflowId);

      try {
        await runWorkflow({
          workflowId,
          taskTitle: "Test no_relaunch_upon_rugpull default",
        });
      } catch {
        // Daemon registration may fail after persisting the run; the assertion below only needs the stored context.
      }

      const { getDb } = await import("../../dist/db.js");
      const db = getDb();
      const rows = db.prepare(
        "SELECT context FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1"
      ).all(workflowId) as { context: string }[];
      assert.ok(rows.length > 0, "run record should exist");
      const ctx = JSON.parse(rows[0].context);
      assert.equal(ctx.no_relaunch_upon_rugpull, "false",
        "no_relaunch_upon_rugpull should default to 'false' when flag is not set");
    });
  });
});

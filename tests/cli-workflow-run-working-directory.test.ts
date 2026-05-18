import fs from "node:fs";
import {
  cleanChildEnv,
  reserveDistinctRandomPorts,
} from "./helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");

async function createTempEnv() {
  const [controlPort, dashboardPort] = await reserveDistinctRandomPorts(2);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-run-cwd-"));
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(path.join(tamanduaDir, "port"), String(dashboardPort), "utf-8");
  return { root, homeDir, tamanduaDir, controlPort, dashboardPort };
}

function writeMinimalWorkflow(homeDir: string, workflowId: string): void {
  const workflowDir = path.join(homeDir, ".tamandua", "workflows", workflowId);
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "workflow.yml"),
    [
      `id: ${workflowId}`,
      "agents:",
      "  - id: dev",
      "    model: fake",
      "    workspace:",
      "      baseDir: .",
      "steps:",
      "  - id: implement",
      "    agent: dev",
      "    input: Implement the task",
      "    expects: STATUS, CHANGES, TESTS",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function runCliUntilOutput(args: string[], env: Record<string, string>, pattern: RegExp): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    const maybeFinish = (code: number | null) => {
      if (finished) return;
      if (pattern.test(stdout)) {
        finished = true;
        clearTimeout(timeout);
        // workflow run may keep process alive due polling timers; stop once output is observed
        if (!child.killed) {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }
        resolve({ stdout, stderr, code });
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      maybeFinish(null);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

async function runCliToExit(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("CLI workflow run working-directory-for-harness", () => {
  it("passes --working-directory-for-harness into run context and cron metadata", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-cwd";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const harnessDir = path.join(env.root, "remote-workdir");
      fs.mkdirSync(harnessDir, { recursive: true });

      const { stdout, stderr } = await runCliUntilOutput(
        [
          "workflow",
          "run",
          workflowId,
          "Validate harness working directory",
          "--working-directory-for-harness",
          harnessDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(env.controlPort) },
        /Harness CWD:/,
      );

      const meaningfulStderr = stderr
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.includes("ExperimentalWarning: SQLite"))
        .filter((line) => !line.includes("--trace-warnings"))
        .join("\n");
      assert.equal(meaningfulStderr, "", `expected no meaningful stderr, got: ${stderr}`);
      assert.match(stdout, /Run: [0-9a-f]{8}/i);
      assert.match(stdout, new RegExp(`Harness CWD: ${path.resolve(harnessDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      const dbPath = path.join(env.tamanduaDir, "tamandua.db");
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare(
          "SELECT context, scheduling_status, scheduling_requested_at FROM runs ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { context: string; scheduling_status: string | null; scheduling_requested_at: string | null } | undefined;
      db.close();

      assert.ok(row, "expected a run row in DB");
      const context = JSON.parse(row!.context) as Record<string, string>;
      assert.equal(context.working_directory_for_harness, path.resolve(harnessDir));

      // Run-scoped scheduling fields are populated for new runs.
      assert.ok(
        row!.scheduling_status === "active" || row!.scheduling_status === "pending_register",
        `expected scheduling_status to be active or pending_register, got ${row!.scheduling_status}`,
      );
      assert.ok(row!.scheduling_requested_at, "expected scheduling_requested_at to be set");
    } finally {
      await runCliToExit(["dashboard", "stop"], {
        HOME: env.homeDir,
        TAMANDUA_CONTROL_PORT: String(env.controlPort),
      }).catch(() => ({ stdout: "", stderr: "", code: null }));
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it("fails fast when --working-directory-for-harness does not exist", async () => {
    const env = await createTempEnv();

    try {
      const workflowId = "cli-run-cwd-invalid";
      writeMinimalWorkflow(env.homeDir, workflowId);

      const missingDir = path.join(env.root, "missing-dir");
      const result = await runCliToExit(
        [
          "workflow",
          "run",
          workflowId,
          "Should fail",
          "--working-directory-for-harness",
          missingDir,
        ],
        { HOME: env.homeDir, TAMANDUA_CONTROL_PORT: String(env.controlPort) },
      );

      assert.equal(result.code, 1, `expected exit code 1, got ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stderr, /working-directory-for-harness does not exist/i);
      assert.ok(!result.stdout.includes("Run:"), "should not print successful run output");
    } finally {
      await runCliToExit(["dashboard", "stop"], {
        HOME: env.homeDir,
        TAMANDUA_CONTROL_PORT: String(env.controlPort),
      }).catch(() => ({ stdout: "", stderr: "", code: null }));
      try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });
});

/******************************************************************************
 * ⚠️  WARNING: SLOW, EXPENSIVE REAL E2E TEST — DO NOT RUN BY DEFAULT  ⚠️
 *
 * This test runs REAL Tamandua workflow executions with a LIVE daemon and
 * scheduler processing steps through actual agent invocations (pi/llm calls).
 *
 * COST/TIME WARNING:
 *   - SPENDS REAL API TOKENS (may cost money)
 *   - Expected runtime: 60–120 minutes (two sequential real workflows)
 *   - Requires a configured pi agent setup (model, provider, auth)
 *   - Uses significant CPU while the daemon processes steps
 *
 * WHEN TO RUN:
 *   - After major changes to the daemon, scheduler, or agent polling infra
 *   - To validate the full Tamandua pipeline end-to-end
 *   - Only via: ./run-all-real-e2e-tests
 *
 * WHEN NOT TO RUN:
 *   - During routine development
 *   - As part of CI
 *   - Unless you explicitly understand the cost and time commitment
 *
 * FOR FAINT OF HEART:
 *   ./run-all-smoke-e2e-tests  — fast state-machine test (~10s, no tokens)
 *
 * This test is separate from the regular test suite (npm test) and is NOT
 * picked up by tsconfig.json or npm test globs. It lives in e2e-tests/.
 *
 * TEST ISOLATION:
 *   - Uses temp HOME isolation via createTempHome()
 *   - Uses reserveDistinctRandomPorts() — no default ports (3334/3338/3339)
 *   - Daemon runs in isolated HOME/TAMANDUA_STATE_DIR
 *   - Worktree directories are created under the isolated HOME (os.homedir()
 *     respects HOME env var), so cleanupTempHome() removes them
 *   - All .tamandua state (DB, events, logs, PID/port files) is in the
 *     isolated temp HOME and removed by cleanupTempHome()
 *   - after() hook + per-test finally blocks guarantee cleanup on failure
 *
 * TEST ORDERING:
 *   The two tests run SEQUENTIALLY (concurrency: 1):
 *   1. feature-dev-merge-worktree — adds a multiply function
 *   2. bug-fix-merge-worktree  — fixes the deliberately broken add function
 *   Test 2 depends on the state produced by Test 1 (same sample repo, shared
 *   temp HOME), so they must execute in order and share the before/after hooks.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  prepareGitRepo,
  resolveFullRunId,
  cleanupTempHome,
} from "./helpers/smoke-helpers.ts";
import {
  startIsolatedDaemon,
  stopIsolatedDaemon,
  waitForRunTerminal,
} from "./helpers/e2e-helpers.ts";
import { reserveDistinctRandomPorts } from "../tests/helpers/test-env.ts";
import type { ChildProcess } from "node:child_process";

const fixtureDir = path.join(process.cwd(), "e2e-tests", "fixtures", "sample-project");

/**
 * Helper: generate pi agent settings pointing at a real model.
 *
 * Derives provider/model/apiKey from environment variables with defaults
 * suitable for Tamandua development. The daemon reads this config when
 * spawning pi agent invocations.
 */
function piAgentSettings(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    defaultProvider: env.TAMANDUA_E2E_PROVIDER || env.PI_PROVIDER || "openai",
    defaultModel: env.TAMANDUA_E2E_MODEL || env.PI_MODEL || "gpt-4o",
    providers: {
      openai: {
        apiKey: env.TAMANDUA_E2E_API_KEY || env.OPENAI_API_KEY || "sk-placeholder",
      },
    },
  });
}

// ── Shared state across both sequential tests ────────────────────────────
let env: Awaited<ReturnType<typeof createTempHome>>;
let repoDir: string;
let daemon: ChildProcess;

describe(
  "real e2e workflows (LIVE agents, daemon, scheduler)",
  {
    // Sequential: tests share the temp HOME and sample repo.
    // High timeout: each individual test may need 45+ minutes.
    concurrency: 1,
  },
  () => {
    // ── before: shared environment setup ──────────────────────────────
    before(async () => {
      // Create isolated temp HOME
      env = await createTempHome();

      // Override the default pi config with real model settings from env vars
      const piAgentDir = path.join(env.homeDir, ".pi", "agent");
      fs.writeFileSync(
        path.join(piAgentDir, "settings.json"),
        piAgentSettings(process.env),
        "utf-8",
      );

      // Install both workflows
      cliMustSucceed(
        ["workflow", "install", "feature-dev-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install feature-dev-merge-worktree",
      );
      cliMustSucceed(
        ["workflow", "install", "bug-fix-merge-worktree"],
        baseEnv(env.homeDir, env.controlPort),
        "install bug-fix-merge-worktree",
      );

      // Prepare a clean git repo from the sample-project fixture.
      // Both tests share this origin repository.
      repoDir = path.join(env.root, "origin-repo");
      prepareGitRepo(fixtureDir, repoDir);
    });

    // ── after: cleanup ─────────────────────────────────────────────────
    after(async () => {
      try {
        await stopIsolatedDaemon(daemon);
      } catch {
        // best-effort
      }
      cleanupTempHome(env);
    });

    // ── TEST 1: feature-dev-merge-worktree ────────────────────────────
    it(
      "feature-dev-merge-worktree: adds multiply function",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Start daemon ────────────────────────────────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Create run ───────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "feature-dev-merge-worktree",
              "Add a multiply function to math.ts that multiplies two numbers",
              "--worktree-origin-repository",
              repoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
          );

          // ── Verify run status ────────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after feature-dev completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Verify repository state ──────────────────────────────
          // After the workflow completes, the origin repo (main branch)
          // should have a squash merge commit with the multiply function.

          // Git log shows a merge commit on main
          const gitLog = execSync(
            "git log --oneline -5",
            { cwd: repoDir, encoding: "utf-8" },
          );
          const commitLines = gitLog.trim().split("\n");
          assert.ok(
            commitLines.length >= 2,
            `Expected at least 2 commits (initial + merge), got:\n${gitLog}`,
          );

          // Multiply function exists in src/math.ts
          const mathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            mathTs.includes("multiply") || mathTs.includes("Multiply"),
            `src/math.ts should contain a multiply function. Content:\n${mathTs}`,
          );

          // Multiply test exists and passes
          execSync("npm run build", { cwd: repoDir, encoding: "utf-8" });
          const testOutput = execSync("npm test", {
            cwd: repoDir,
            encoding: "utf-8",
          });
          assert.ok(
            testOutput.includes("multiply") || testOutput.includes("Multiply") || testOutput.match(/pass|OK|0 fail/),
            `Tests should reference multiply and pass. Output:\n${testOutput.substring(0, 500)}`,
          );

          // Multiply test file exists
          const multiplyTestPath = path.join(repoDir, "test", "math.test.ts");
          if (fs.existsSync(multiplyTestPath)) {
            const testContent = fs.readFileSync(multiplyTestPath, "utf-8");
            assert.ok(
              testContent.includes("multiply") || testContent.includes("Multiply"),
              `math.test.ts should contain multiply tests. Content:\n${testContent.substring(0, 500)}`,
            );
          }
        } finally {
          // ── Stop daemon between workflows for clean scheduler state ─
          await stopIsolatedDaemon(daemon);
        }
      },
    );

    // ── TEST 2: bug-fix-merge-worktree (sequential, same repo) ──────
    it(
      "bug-fix-merge-worktree: fixes broken add function (sequential, same repo)",
      { timeout: 60 * 60_000 }, // 60 minutes
      async () => {
        // ── Restart daemon for clean scheduler state ────────────────
        daemon = await startIsolatedDaemon(
          env.dashboardPort,
          env.homeDir,
          env.controlPort,
        );

        try {
          // ── Verify precondition: add function is still broken ────
          // The sample-project has `a - b` — confirm it hasn't been
          // accidentally fixed by the feature workflow's merge.
          const preMathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            preMathTs.includes("a - b") || preMathTs.includes("a-b"),
            `Precondition: add function should be broken (a - b). Content:\n${preMathTs}`,
          );

          // ── Create run ───────────────────────────────────────────
          const runIdPrefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "bug-fix-merge-worktree",
              "The add function in src/math.ts returns a - b instead of a + b",
              "--worktree-origin-repository",
              repoDir,
            ],
            baseEnv(env.homeDir, env.controlPort),
          );
          const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

          // ── Wait for completion ──────────────────────────────────
          await waitForRunTerminal(
            runId,
            baseEnv(env.homeDir, env.controlPort),
            45 * 60_000, // 45 min timeout
            10_000,       // poll every 10s
          );

          // ── Verify run status ────────────────────────────────────
          const statusOut = cliMustSucceed(
            ["workflow", "status", runId],
            baseEnv(env.homeDir, env.controlPort),
            "workflow status after bug-fix completion",
          );
          assert.match(statusOut, /Status:\s+completed/i);

          // ── Verify repository state ──────────────────────────────
          // After the bug-fix workflow completes, the origin repo should
          // have a fix for the add function AND still have multiply.

          // Git log shows a merge commit for the fix on main
          const gitLog = execSync(
            "git log --oneline -5",
            { cwd: repoDir, encoding: "utf-8" },
          );
          const commitLines = gitLog.trim().split("\n");
          assert.ok(
            commitLines.length >= 3,
            `Expected at least 3 commits (initial + feature merge + fix merge), got:\n${gitLog}`,
          );

          // Add function is FIXED: returns a + b (not a - b)
          const mathTs = fs.readFileSync(
            path.join(repoDir, "src", "math.ts"),
            "utf-8",
          );
          assert.ok(
            mathTs.includes("a + b") || mathTs.includes("a+b"),
            `src/math.ts add function should be fixed (a + b). Content:\n${mathTs}`,
          );
          assert.ok(
            !mathTs.includes("a - b") && !mathTs.includes("a-b"),
            `src/math.ts should NOT contain the broken subtract logic. Content:\n${mathTs}`,
          );

          // Assert the actual runtime behavior: add(5, 3) === 8
          // Compile and run the tests
          execSync("npm run build", { cwd: repoDir, encoding: "utf-8" });
          const testOutput = execSync("npm test", {
            cwd: repoDir,
            encoding: "utf-8",
          });
          assert.ok(
            testOutput.match(/pass|OK|0 fail/),
            `Tests should pass after fix. Output:\n${testOutput.substring(0, 500)}`,
          );

          // add(5, 3) === 8 should be asserted in tests
          const testPath = path.join(repoDir, "test", "math.test.ts");
          if (fs.existsSync(testPath)) {
            const testContent = fs.readFileSync(testPath, "utf-8");
            // The fixed test should expect add(5, 3) === 8
            assert.ok(
              testContent.includes("8"),
              `math.test.ts should assert add(5, 3) === 8 after fix. Content:\n${testContent.substring(0, 500)}`,
            );
            // Should NOT still assert add(5, 3) === 2
            assert.ok(
              !testContent.match(/add\(5,\s*3\).*2/) && !testContent.includes("expects subtraction"),
              `math.test.ts should no longer assert the buggy value 2. Content:\n${testContent.substring(0, 500)}`,
            );
          }

          // ── Verify multiply still exists (no regression) ─────────
          assert.ok(
            mathTs.includes("multiply") || mathTs.includes("Multiply"),
            `multiply function should still exist after bug-fix. Content:\n${mathTs}`,
          );
          assert.ok(
            testOutput.includes("multiply") || testOutput.includes("Multiply"),
            `Multiply tests should still pass after bug-fix. Output:\n${testOutput.substring(0, 500)}`,
          );
        } finally {
          // ── Stop daemon ─────────────────────────────────────────
          await stopIsolatedDaemon(daemon);
        }
      },
    );
  },
);

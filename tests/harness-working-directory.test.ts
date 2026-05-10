import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-harness-cwd-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
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

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("working-directory-for-harness", () => {
  it("runWorkflow persists and applies explicit workingDirectoryForHarness", () => {
    const temp = createTempHome();

    try {
      const workflowId = "harness-explicit";
      writeMinimalWorkflow(temp.homeDir, workflowId);

      const harnessDir = path.join(temp.root, "project");
      fs.mkdirSync(harnessDir, { recursive: true });

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { runWorkflow } from "./dist/installer/run.js";
          import { getDb } from "./dist/db.js";
          import { shutdownAllCrons } from "./dist/installer/agent-scheduler.js";

          try {
            const started = await runWorkflow({
              workflowId: "${workflowId}",
              taskTitle: "Use explicit harness cwd",
              workingDirectoryForHarness: process.env.HARNESS_DIR,
            });

            const db = getDb();
            const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(started.runId);
            const context = JSON.parse(row.context);
            const cronJobs = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".tamandua", "cron-jobs.json"), "utf-8"));

            console.log(JSON.stringify({
              resultDir: started.workingDirectoryForHarness,
              contextDir: context.working_directory_for_harness,
              cronDir: cronJobs[0]?.workingDirectoryForHarness ?? cronJobs[0]?.workdir ?? null,
            }));
          } finally {
            shutdownAllCrons();
          }
        `,
        {
          HOME: temp.homeDir,
          HARNESS_DIR: harnessDir,
        },
      );

      const expected = path.resolve(harnessDir);
      assert.equal(result.resultDir, expected);
      assert.equal(result.contextDir, expected);
      assert.equal(result.cronDir, expected);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("defaults workingDirectoryForHarness to the current cwd", () => {
    const temp = createTempHome();

    try {
      const workflowId = "harness-default";
      writeMinimalWorkflow(temp.homeDir, workflowId);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { runWorkflow } from "./dist/installer/run.js";
          import { getDb } from "./dist/db.js";
          import { shutdownAllCrons } from "./dist/installer/agent-scheduler.js";

          try {
            const started = await runWorkflow({
              workflowId: "${workflowId}",
              taskTitle: "Use default harness cwd",
            });

            const db = getDb();
            const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(started.runId);
            const context = JSON.parse(row.context);
            const cronJobs = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".tamandua", "cron-jobs.json"), "utf-8"));

            console.log(JSON.stringify({
              cwd: process.cwd(),
              resultDir: started.workingDirectoryForHarness,
              contextDir: context.working_directory_for_harness,
              cronDir: cronJobs[0]?.workingDirectoryForHarness ?? cronJobs[0]?.workdir ?? null,
            }));
          } finally {
            shutdownAllCrons();
          }
        `,
        {
          HOME: temp.homeDir,
        },
      );

      const expected = path.resolve(repoRoot);
      assert.equal(result.cwd, expected);
      assert.equal(result.resultDir, expected);
      assert.equal(result.contextDir, expected);
      assert.equal(result.cronDir, expected);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});

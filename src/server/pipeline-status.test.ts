import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma, resetPrisma } from "../../dist/database/index.js";
import { getDb } from "../../dist/db.js";
import { getCurrentPhase, getCurrentPhases } from "../../dist/server/pipeline-status.js";

// Temp-DB helper (same pattern as dashboard.test.ts): point HOME +
// FORMIGA_DB_PATH at a scratch dir, then let getDb() trigger the migration.
function makeTempDb(): { cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-pipeline-status-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const dbPath = path.join(homeDir, ".formiga", "formiga.db");
  const previousHome = process.env.HOME;
  const previousDbPath = process.env.FORMIGA_DB_PATH;
  process.env.HOME = homeDir;
  process.env.FORMIGA_DB_PATH = dbPath;
  return {
    cleanup() {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function seedRun(id: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.run.create({
    data: {
      id,
      workflow_id: "wf-1",
      task: `task ${id}`,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });
}

async function seedExperiment(
  runId: string,
  roundNumber: number,
  agentName: string,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.experiment.create({
    data: {
      run_id: runId,
      round_number: roundNumber,
      agent_name: agentName,
      model_type: "xgboost",
      train_metric: 1,
      val_metric: 1,
      metric_name: "accuracy",
      artifact_path: "artifacts/x",
    },
  });
}

let env: ReturnType<typeof makeTempDb>;

describe("getCurrentPhases (M-5 batched)", () => {
  beforeEach(async () => {
    env = makeTempDb();
    await resetPrisma();
    getDb(); // opens + migrates the scratch DB
  });

  afterEach(async () => {
    await resetPrisma();
    env.cleanup();
  });

  it("matches the single-run getCurrentPhase result for every seeded run", async () => {
    await seedRun("run-data");
    await seedExperiment("run-data", 1, "data-analyst");

    await seedRun("run-arena");
    await seedExperiment("run-arena", 1, "data-analyst");
    await getPrisma().arenaSession.create({
      data: {
        run_id: "run-arena",
        metric_name: "accuracy",
        metric_direction: "maximize",
        benchmark_script: "scripts/bench.py",
      },
    });

    // No experiments — steps-table fallback.
    await seedRun("run-steps");
    await getPrisma().step.create({
      data: {
        id: "step-run-steps-eda",
        run_id: "run-steps",
        step_id: "eda",
        agent_id: "data-analyst",
        step_index: 0,
        input_template: "t",
        expects: "e",
        status: "done",
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    // Nothing at all → idle.
    await seedRun("run-idle");

    const runIds = ["run-data", "run-arena", "run-steps", "run-idle"];
    const batched = await getCurrentPhases(runIds);

    for (const runId of runIds) {
      const individual = await getCurrentPhase(runId);
      assert.equal(
        batched.get(runId),
        individual,
        `batched phase for ${runId} (${batched.get(runId)}) should equal individual (${individual})`,
      );
    }

    assert.equal(batched.get("run-data"), "data_analysis");
    assert.equal(batched.get("run-arena"), "arena");
    assert.equal(batched.get("run-steps"), "data_analysis");
    assert.equal(batched.get("run-idle"), "idle");
  });

  it("derives audit/modeling/feature_engineering from the current-round agents", async () => {
    await seedRun("run-audit");
    await seedExperiment("run-audit", 1, "ml-critic");

    await seedRun("run-modeling");
    await seedExperiment("run-modeling", 1, "modeler-classic");

    await seedRun("run-features");
    await seedExperiment("run-features", 1, "feature-engineer");

    const phases = await getCurrentPhases(["run-audit", "run-modeling", "run-features"]);
    assert.equal(phases.get("run-audit"), "audit");
    assert.equal(phases.get("run-modeling"), "modeling");
    assert.equal(phases.get("run-features"), "feature_engineering");
  });

  it("uses the highest round to pick which agents define the phase", async () => {
    await seedRun("run-multi");
    await seedExperiment("run-multi", 1, "data-analyst");
    await seedExperiment("run-multi", 2, "ml-critic");

    const phases = await getCurrentPhases(["run-multi"]);
    // Round 1's data-analyst must not win — the phase follows round 2's agent.
    assert.equal(phases.get("run-multi"), "audit");
  });

  it("returns an empty map for an empty input", async () => {
    const phases = await getCurrentPhases([]);
    assert.equal(phases.size, 0);
  });
});

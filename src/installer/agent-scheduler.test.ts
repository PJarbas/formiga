// ══════════════════════════════════════════════════════════════════════
// agent-scheduler.test.ts — Contract tests for the run-scoped scheduler
// ══════════════════════════════════════════════════════════════════════
//
// These tests assert the CURRENT deliberate scheduler contract (see issue
// #118). Behaviour under test:
//
//   • Fast polling: setupAgentCrons uses a fixed 2-minute interval (5 in
//     noHurrySaveTokensMode) and IGNORES polling.timeoutSeconds. The old
//     5/15/ceil(timeout/60) semantics were removed in the sequential-scheduler
//     refactor — that was the drift that broke these tests on main.
//   • Sequential scheduling: only agents with pending steps get jobs; with no
//     pending steps the first agent is scheduled as a fallback. Double-setup
//     is idempotent (job identity = formiga-<workflow>-<run>-<agent>).
//   • Harness workdir: executePollingRound refuses to run (and tears the job
//     down) when workingDirectoryForHarness is missing. Callers must pass it.
//   • Harness type: createAgentCronJob reads harness_type from the run
//     context (hermes) and defaults to "pi".
//   • Nudge: skips in-flight jobs, skips agents with no work (guarded on the
//     full prefixed agent id), converts pending-start timers to active
//     intervals, and preserves job metadata.
//
// DB isolation: a temp HOME + FORMIGA_DB_PATH is used and getDb() is called
// in before() so migrate() runs before any Prisma query. The old tests wrote
// to the real ~/.formiga/formiga.db (UNIQUE constraint failures).
// ══════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "../../dist/db.js";
import {
  setupAgentCrons,
  createAgentCronJob,
  _getJobIntervalsForRun,
  shutdownAllCrons,
  tryMarkJobInFlight,
  nudgeScheduledRuns,
} from "../../dist/installer/agent-scheduler.js";
import {
  jobMetadata,
  inFlightJobs,
  activeTimers,
  pendingStartTimers,
} from "../../dist/installer/scheduler/shared.js";
import type { WorkflowSpec } from "../../dist/installer/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const WORKFLOW_ID = "test-workflow";

function makeWorkflow(
  agents = [{ id: "test-agent", model: "fake", workspace: { baseDir: "." } }],
  pollingTimeoutSeconds?: number,
): WorkflowSpec {
  return {
    id: WORKFLOW_ID,
    name: "Test",
    agents,
    steps: agents.map((a, i) => ({
      id: `step-${i + 1}`,
      agent: a.id,
      input: "do something",
      expects: "STATUS",
    })),
    ...(pollingTimeoutSeconds !== undefined
      ? { polling: { timeoutSeconds: pollingTimeoutSeconds } }
      : {}),
  } as WorkflowSpec;
}

// Mock spec used by the nudge group — contains every short agent id the
// tests seed so the agent lookup inside nudgeScheduledRuns succeeds without
// touching disk.
const mockSpec: WorkflowSpec = {
  id: WORKFLOW_ID,
  name: "Test",
  agents: [
    { id: "dev", workspace: { baseDir: "/tmp", files: {} } },
    { id: "agent-a", workspace: { baseDir: "/tmp", files: {} } },
    { id: "agent-b", workspace: { baseDir: "/tmp", files: {} } },
  ],
  steps: [],
} as WorkflowSpec;
const mockLoadSpec = async (): Promise<WorkflowSpec> => mockSpec;

// ── Isolation ─────────────────────────────────────────────────────────

let tempHome: string;
let origHome: string | undefined;
let origDbPath: string | undefined;
let origStateDir: string | undefined;

before(() => {
  tempHome = mkdtempSync(path.join(os.tmpdir(), "formiga-agent-scheduler-test-"));
  origHome = process.env.HOME;
  origDbPath = process.env.FORMIGA_DB_PATH;
  origStateDir = process.env.FORMIGA_STATE_DIR;
  process.env.HOME = tempHome;
  process.env.FORMIGA_DB_PATH = path.join(tempHome, ".formiga", "test.db");
  process.env.FORMIGA_STATE_DIR = path.join(tempHome, ".formiga");
  // First getDb() call migrates the schema; Prisma reads the same file.
  getDb();
});

after(() => {
  // Active interval/pending timers (setupAgentCrons creates real ones) would
  // otherwise keep the test process alive.
  shutdownAllCrons();
  if (origHome) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origDbPath) process.env.FORMIGA_DB_PATH = origDbPath;
  else delete process.env.FORMIGA_DB_PATH;
  if (origStateDir) process.env.FORMIGA_STATE_DIR = origStateDir;
  else delete process.env.FORMIGA_STATE_DIR;
  rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(() => {
  shutdownAllCrons();
  const db = getDb();
  db.exec("DELETE FROM steps");
  db.exec("DELETE FROM runs");
  db.exec("DELETE FROM job_registry");
  for (const id of [...inFlightJobs]) inFlightJobs.delete(id);
  for (const id of [...activeTimers.keys()]) activeTimers.delete(id);
  for (const id of [...pendingStartTimers.keys()]) pendingStartTimers.delete(id);
  for (const id of [...jobMetadata.keys()]) jobMetadata.delete(id);
});

// Raw-SQL seeders (better-sqlite3) — these run against the temp DB that
// getDb() migrated in before().
function insertRun(runId: string, status = "running", context = "{}"): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, '${WORKFLOW_ID}', 'test', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(runId, status, context);
}

function insertStep(runId: string, agentId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
                                    status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'plan', ?, 0, '', '', 'pending', 0, 3, 'single', datetime('now'), datetime('now'))`,
    )
    .run(`step-${runId}-${agentId}`, runId, agentId);
}

/**
 * Register a job exactly as setupAgentCrons would, plus a paused run and a
 * full-prefixed pending step so nudgeScheduledRuns passes both its guards:
 *   - no-work guard keys on `${runId}::${fullPrefixedAgentId}`
 *   - the fire-and-forget polling round hits the paused-run branch and
 *     returns without spawning a harness or tearing the job down.
 */
function seedJob(
  runId: string,
  agentRawId: string,
  opts: { inFlight?: boolean; pendingTimer?: boolean; harnessType?: string } = {},
): { jobId: string; agentId: string } {
  const jobId = `formiga-${WORKFLOW_ID}-${runId}-${agentRawId}`;
  const agentId = `${WORKFLOW_ID}_${agentRawId}`;
  insertRun(runId, "paused");
  insertStep(runId, agentId);
  jobMetadata.set(jobId, {
    id: jobId,
    workflowId: WORKFLOW_ID,
    runId,
    agentId,
    intervalMinutes: 2,
    sessionLabel: `${agentRawId}-cron`,
    timeoutSeconds: 600,
    workingDirectoryForHarness: tempHome,
    harnessType: opts.harnessType ?? "pi",
    createdAt: new Date().toISOString(),
  });
  if (opts.inFlight) inFlightJobs.add(jobId);
  if (opts.pendingTimer) {
    const t = setTimeout(() => {}, 60_000);
    t.unref();
    pendingStartTimers.set(jobId, t);
  }
  return { jobId, agentId };
}

// ── setupAgentCrons: fast-polling intervals ───────────────────────────

describe("setupAgentCrons fast-polling intervals", () => {
  it("uses 2-minute fast polling by default", async () => {
    const workflow = makeWorkflow();
    const runId = "run-default";
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 2);
  });

  it("uses 5-minute fast polling in noHurrySaveTokensMode", async () => {
    const workflow = makeWorkflow();
    const runId = "run-save";
    await setupAgentCrons(workflow, runId, {
      noHurrySaveTokensMode: true,
      workingDirectoryForHarness: ".",
    });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);
  });

  it("ignores polling.timeoutSeconds in normal mode (33s → still 2)", async () => {
    const workflow = makeWorkflow(undefined, 33);
    const runId = "run-timeout-ignored";
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 2);
  });

  it("ignores polling.timeoutSeconds in save mode (1200s → still 5)", async () => {
    const workflow = makeWorkflow(undefined, 1200);
    const runId = "run-save-timeout-ignored";
    await setupAgentCrons(workflow, runId, {
      noHurrySaveTokensMode: true,
      workingDirectoryForHarness: ".",
    });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);
  });

  it("noHurrySaveTokensMode=false uses 2-minute fast polling", async () => {
    const workflow = makeWorkflow();
    const runId = "run-normal";
    await setupAgentCrons(workflow, runId, {
      noHurrySaveTokensMode: false,
      workingDirectoryForHarness: ".",
    });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 2);
  });

  it("works with multiple agents", async () => {
    const workflow = makeWorkflow([
      { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
      { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
    ]);
    const runId = "run-multi";
    // Seed pending steps with RAW agent ids: getAgentsForPendingSteps matches
    // them for scheduling, but the immediate round's pending-work check (which
    // uses the full prefixed agent id) finds no work → heartbeat path → the
    // jobs survive without spawning a harness.
    insertRun(runId);
    insertStep(runId, "agent-a");
    insertStep(runId, "agent-b");
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 2);
    for (const job of intervals) {
      assert.equal(job.intervalMinutes, 2);
    }
  });

  it("tears down the job immediately when workingDirectoryForHarness is missing", async () => {
    // executePollingRound refuses a round without a harness workdir and tears
    // down the just-registered job. setupAgentCrons callers MUST pass
    // workingDirectoryForHarness.
    const workflow = makeWorkflow();
    const runId = "run-no-workdir";
    await setupAgentCrons(workflow, runId);

    assert.equal(_getJobIntervalsForRun(runId).length, 0);
  });
});

// ── setupAgentCrons: sequential scheduling ────────────────────────────

describe("setupAgentCrons sequential scheduling", () => {
  it("falls back to the first agent when no steps are pending", async () => {
    const workflow = makeWorkflow([
      { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
      { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
    ]);
    const runId = "run-fallback";
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].agentId, `${WORKFLOW_ID}_agent-a`);
  });

  it("schedules one job per agent with pending steps", async () => {
    const workflow = makeWorkflow([
      { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
      { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
    ]);
    const runId = "run-seq";
    insertRun(runId);
    insertStep(runId, "agent-a");
    insertStep(runId, "agent-b");
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 2);
    const agentIds = intervals.map((j) => j.agentId).sort();
    assert.deepEqual(agentIds, [`${WORKFLOW_ID}_agent-a`, `${WORKFLOW_ID}_agent-b`]);
  });

  it("is idempotent across double setup", async () => {
    const workflow = makeWorkflow();
    const runId = "run-idempotent";
    insertRun(runId);
    insertStep(runId, "test-agent");
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });
    await setupAgentCrons(workflow, runId, { workingDirectoryForHarness: "." });

    assert.equal(_getJobIntervalsForRun(runId).length, 1);
  });
});

// ── createAgentCronJob: harness type ──────────────────────────────────

describe("createAgentCronJob harness type", () => {
  it("reads harness_type 'hermes' from the run context", async () => {
    const workflow = makeWorkflow();
    const runId = "run-hermes-harness";
    insertRun(runId, "running", '{"harness_type":"hermes"}');

    const res = await createAgentCronJob({
      workflowId: WORKFLOW_ID,
      runId,
      agent: workflow.agents[0],
      workflow,
      intervalMinutes: 2,
      staggerOffsetMs: 60_000,
      workingDirectoryForHarness: tempHome,
    });

    assert.equal(res.ok, true);
    assert.equal(jobMetadata.get(res.id)?.harnessType, "hermes");
  });

  it("reads harness_type 'opencode' from the run context", async () => {
    const workflow = makeWorkflow();
    const runId = "run-opencode-harness";
    insertRun(runId, "running", '{"harness_type":"opencode"}');

    const res = await createAgentCronJob({
      workflowId: WORKFLOW_ID,
      runId,
      agent: workflow.agents[0],
      workflow,
      intervalMinutes: 2,
      staggerOffsetMs: 60_000,
      workingDirectoryForHarness: tempHome,
    });

    assert.equal(res.ok, true);
    assert.equal(jobMetadata.get(res.id)?.harnessType, "opencode");
  });

  it("defaults to 'pi' when the run context has no harness_type", async () => {
    const workflow = makeWorkflow();
    const runId = "run-pi-harness";
    insertRun(runId, "running", "{}");

    const res = await createAgentCronJob({
      workflowId: WORKFLOW_ID,
      runId,
      agent: workflow.agents[0],
      workflow,
      intervalMinutes: 2,
      staggerOffsetMs: 60_000,
      workingDirectoryForHarness: tempHome,
    });

    assert.equal(res.ok, true);
    assert.equal(jobMetadata.get(res.id)?.harnessType, "pi");
  });
});

// ── tryMarkJobInFlight race guard ─────────────────────────────────────

describe("tryMarkJobInFlight race guard", () => {
  it("returns true on first call for a given jobId", () => {
    const result = tryMarkJobInFlight("job-001");
    assert.equal(result, true);
  });

  it("returns false on second call for same jobId", () => {
    tryMarkJobInFlight("job-002");
    const result = tryMarkJobInFlight("job-002");
    assert.equal(result, false);
  });

  it("returns true for different jobIds", () => {
    const r1 = tryMarkJobInFlight("job-a");
    const r2 = tryMarkJobInFlight("job-b");
    assert.equal(r1, true);
    assert.equal(r2, true);
  });

  it("subsequent call after first returns false (three calls)", () => {
    assert.equal(tryMarkJobInFlight("job-003"), true);
    assert.equal(tryMarkJobInFlight("job-003"), false);
    assert.equal(tryMarkJobInFlight("job-003"), false);
  });

  it("is idempotent — check-and-add happens synchronously", () => {
    const wins: boolean[] = [];
    for (let i = 0; i < 2; i++) {
      wins.push(tryMarkJobInFlight("job-concurrent"));
    }
    assert.deepEqual(wins, [true, false]);
  });

  it("different jobIds are independent", () => {
    tryMarkJobInFlight("job-004");
    assert.equal(tryMarkJobInFlight("job-005"), true);
    assert.equal(tryMarkJobInFlight("job-004"), false);
  });

  it("shutdown clears in-flight state", () => {
    tryMarkJobInFlight("job-006");
    shutdownAllCrons();
    assert.equal(tryMarkJobInFlight("job-006"), true);
  });
});

// ── nudgeScheduledRuns ────────────────────────────────────────────────

describe("nudgeScheduledRuns", () => {
  it("returns empty result for empty runIds", async () => {
    const result = await nudgeScheduledRuns([]);
    assert.deepStrictEqual(result.runIds, []);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("returns empty result for non-existent runIds", async () => {
    const result = await nudgeScheduledRuns(["no-such-run"]);
    assert.equal(result.runIds.length, 1);
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 0);
  });

  it("skips jobs that are in flight", async () => {
    seedJob("run-skip", "dev", { inFlight: true });

    const result = await nudgeScheduledRuns(["run-skip"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 0);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "skipped_in_flight");
    assert.equal(result.jobs[0].agentId, `${WORKFLOW_ID}_dev`);
    assert.equal(result.jobs[0].runId, "run-skip");
  });

  it("launches for non-in-flight scheduled jobs", async () => {
    seedJob("run-launch", "dev");

    const result = await nudgeScheduledRuns(["run-launch"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "launched");
    assert.equal(result.jobs[0].runId, "run-launch");
    assert.equal(result.jobs[0].agentId, `${WORKFLOW_ID}_dev`);
  });

  it("nudges only matching runs, ignoring others", async () => {
    seedJob("run-a", "dev");
    seedJob("run-b", "dev");

    const result = await nudgeScheduledRuns(["run-a"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 0);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].runId, "run-a");
  });

  it("converts pending-start timer to active interval on nudge", async () => {
    const { jobId } = seedJob("run-pending", "dev", { pendingTimer: true });

    const result = await nudgeScheduledRuns(["run-pending"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 1);
    assert.equal(pendingStartTimers.has(jobId), false);
    assert.equal(activeTimers.has(jobId), true);
    assert.equal(_getJobIntervalsForRun("run-pending").length, 1);
  });

  it("preserves job metadata (harness type) through nudge", async () => {
    const { jobId } = seedJob("run-harness", "dev", { harnessType: "hermes" });

    const result = await nudgeScheduledRuns(["run-harness"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(jobMetadata.get(jobId)?.harnessType, "hermes");
  });

  it("returns errors for jobs whose workflow is missing from disk", async () => {
    // No loadWorkflowSpec override: the default loader reads
    // <FORMIGA_STATE_DIR>/workflows/test-workflow/workflow.yml, which does not
    // exist in the temp HOME.
    seedJob("run-err", "dev");

    const result = await nudgeScheduledRuns(["run-err"]);
    assert.equal(result.launched, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].status, "error");
    assert.ok(result.errors[0].error.length > 0);
  });

  it("handles mixed in-flight and launchable jobs", async () => {
    seedJob("run-mixed", "agent-a", { inFlight: true });
    seedJob("run-mixed", "agent-b");

    const result = await nudgeScheduledRuns(["run-mixed"], { loadWorkflowSpec: mockLoadSpec });
    assert.equal(result.launched, 1);
    assert.equal(result.skippedInFlight, 1);
    assert.equal(result.jobs.length, 2);

    const launched = result.jobs.filter((j) => j.status === "launched");
    const skipped = result.jobs.filter((j) => j.status === "skipped_in_flight");
    assert.equal(launched.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(launched[0].agentId, `${WORKFLOW_ID}_agent-b`);
    assert.equal(skipped[0].agentId, `${WORKFLOW_ID}_agent-a`);
  });
});

// ══════════════════════════════════════════════════════════════════════
// arena-resume.test.ts — AL-4: the arena loop resumes from a persisted
// `state_json` checkpoint after a daemon restart instead of restarting the
// run from round 1 (and instead of being marked failed by the reconciler).
//
// runAgentsParallel is injected, so no LLM is ever called. Agents return
// null (agent_no_response) — a crash result that exercises the round loop +
// checkpoint persistence without needing a real Python environment.
//
// The FakeArenaRepo is stateful so we can assert what runArena actually did:
//   - createCalls / setBaselineCalls: a resume must NOT re-create the session
//     or re-establish the baseline (setBaseline would wipe best_metric).
//   - checkpoint: the last persisted state_json, round-tripped back out.
//   - finalizeStatus: the terminal status written on convergence.
// ══════════════════════════════════════════════════════════════════════

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runArena } from "./arena-engine.js";
import type { ArenaRepository } from "./arena-repository.js";
import type { ArenaConfig, ArenaSession, ArenaAgentConfig, ArenaStatus, ArenaDecision } from "./arena-types.js";
import type { ArenaExperiment } from "../leaderboard/repository.js";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-resume-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const AGENT: ArenaAgentConfig = {
  id: "modeler-classic",
  agentPersona: "modeler_classic",
  timeout: 300_000,
  strategyHint: "teste",
  modelType: "lightgbm",
};

function makeConfig(ws: string): ArenaConfig {
  return {
    runId: "run-resume-test",
    workspacePath: ws,
    metricName: "f1",
    metricDirection: "higher",
    maxRounds: 5,
    maxNoImprove: 5,
    commitOnKeep: false,
    revertOnDiscard: false,
    agents: [AGENT],
  };
}

function makeSession(overrides: Partial<ArenaSession> = {}): ArenaSession {
  return {
    id: "session-resume",
    runId: "run-resume-test",
    metricName: "f1",
    metricDirection: "higher",
    benchmarkScript: null,
    checksScript: null,
    targetMetric: null,
    maxRounds: 5,
    maxNoImprove: 5,
    currentRound: 0,
    bestMetric: null,
    bestAgent: null,
    bestExperimentId: null,
    baselineMetric: null,
    noiseFloorMad: null,
    status: "running",
    totalKeep: 0,
    totalDiscard: 0,
    totalCrash: 0,
    totalChecksFailed: 0,
    consecutiveNoImprove: 0,
    stateJson: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

interface CheckpointShape {
  version: number;
  allResults: unknown[];
  bestFoldScores: number[] | null;
  teamExperimentCount: Record<string, number>;
  existingDedupSignatures: string[];
  consecutiveNoImprove: number;
}

/** In-memory stateful repo: the single source of truth is `session`. */
class FakeArenaRepo implements ArenaRepository {
  session: ArenaSession | null;
  createCalls = 0;
  setBaselineCalls = 0;
  checkpoint: string | null = null;
  finalizeStatus: ArenaStatus | null = null;

  constructor(session: ArenaSession | null) { this.session = session; }

  async getByRunId(): Promise<ArenaSession | null> { return this.session; }
  async getById(): Promise<ArenaSession | null> { return this.session; }
  async createFromConfig(runId: string, config: ArenaConfig): Promise<ArenaSession> {
    this.createCalls += 1;
    this.session = makeSession();
    return this.session;
  }
  async update(s: ArenaSession): Promise<void> { this.session = s; }
  async updateRound(
    _id: string,
    currentRound: number,
    bestMetric: number | null,
    bestAgent: string | null,
    _bestExperimentId: number | null,
    consecutiveNoImprove: number,
  ): Promise<void> {
    if (this.session) {
      this.session.currentRound = currentRound;
      this.session.bestMetric = bestMetric;
      this.session.bestAgent = bestAgent;
      this.session.consecutiveNoImprove = consecutiveNoImprove;
    }
  }
  async updateStats(_id: string, decision: ArenaDecision): Promise<void> {
    if (!this.session) return;
    if (decision === "keep" || decision === "baseline") this.session.totalKeep += 1;
    else if (decision === "discard") this.session.totalDiscard += 1;
    else if (decision === "crash") this.session.totalCrash += 1;
    else if (decision === "checks_failed") this.session.totalChecksFailed += 1;
  }
  async saveCheckpoint(_id: string, stateJson: string): Promise<void> { this.checkpoint = stateJson; }
  async finalize(_id: string, status: ArenaStatus): Promise<void> {
    if (this.session) this.session.status = status;
    this.finalizeStatus = status;
  }
  async setBaseline(_id: string, baselineMetric: number): Promise<void> {
    this.setBaselineCalls += 1;
    if (this.session) {
      this.session.baselineMetric = baselineMetric;
      this.session.bestMetric = baselineMetric;
    }
  }
  async setNoiseFloor(): Promise<void> {}
}

function makeLeaderboard() {
  const registrations: ArenaExperiment[] = [];
  return {
    registrations,
    registerArena: async (entry: ArenaExperiment) => { registrations.push(entry); return registrations.length; },
    getBestByDatasetSignature: async () => [],
  };
}

/**
 * A checkpoint a 2-round crash run would have persisted: two
 * agent_no_response results, teamExperimentCount at 2, no-improve streak 2.
 */
function twoRoundCheckpoint(): string {
  return JSON.stringify({
    version: 1,
    allResults: [
      { agentId: "modeler-classic", hypothesis: "h1", learned: "l1", nextFocus: "f1", metric: null, decision: "crash", notes: null },
      { agentId: "modeler-classic", hypothesis: "h2", learned: "l2", nextFocus: "f2", metric: null, decision: "crash", notes: null },
    ],
    bestFoldScores: null,
    teamExperimentCount: { "modeler-classic": 2 },
    existingDedupSignatures: [],
    consecutiveNoImprove: 2,
  });
}

// ── Resume from checkpoint ──────────────────────────────────────────────

describe("runArena — resume from checkpoint (AL-4)", () => {
  it("skips completed rounds, does not re-create or re-baseline, and persists an extended checkpoint", async () => {
    const ws = makeWorkspace();
    const session = makeSession({
      currentRound: 2,
      bestMetric: 0.5,
      bestAgent: "modeler-classic",
      baselineMetric: 0.7,
      stateJson: twoRoundCheckpoint(),
    });
    const repo = new FakeArenaRepo(session);
    const runParallelRounds: number[] = [];
    const runAgentsParallel = async () => {
      runParallelRounds.push(repo.session!.currentRound);
      return { "modeler-classic": null };
    };

    const result = await runArena(makeConfig(ws), repo, makeLeaderboard(), runAgentsParallel);

    assert.equal(repo.createCalls, 0, "resume must not re-create the session");
    assert.equal(repo.setBaselineCalls, 0, "resume must not re-establish the baseline (would wipe best_metric)");
    // Only rounds 3, 4, 5 run — rounds 1 and 2 were already completed.
    assert.deepEqual(runParallelRounds, [3, 4, 5]);
    assert.equal(result.totalRounds, 5);
    assert.equal(result.status, "converged");
    assert.equal(repo.finalizeStatus, "converged");
    assert.equal(result.bestMetric, 0.5, "best_metric from the pre-restart run must survive");

    // The final checkpoint contains the restored 2 results + 3 new ones, and
    // carries the counters across serialize → parse → serialize.
    const finalCp = JSON.parse(repo.checkpoint!) as CheckpointShape;
    assert.equal(finalCp.allResults.length, 5, "2 restored + 3 new crash results");
    assert.equal(finalCp.teamExperimentCount["modeler-classic"], 2, "team counter must be preserved across the checkpoint");
    assert.equal(finalCp.consecutiveNoImprove, 5, "2 restored + 3 new no-improve rounds");
  });
});

// ── Terminal session: crash between finalize and step-complete ───────────

describe("runArena — terminal session (crash between finalize and step-complete)", () => {
  it("returns the finalized result without running any rounds", async () => {
    const ws = makeWorkspace();
    const session = makeSession({
      currentRound: 4,
      bestMetric: 0.9,
      bestAgent: "modeler-classic",
      status: "converged",
      totalKeep: 2,
      totalCrash: 4,
    });
    const repo = new FakeArenaRepo(session);
    let calls = 0;
    const runAgentsParallel = async () => { calls++; return { "modeler-classic": null }; };

    const result = await runArena(makeConfig(ws), repo, makeLeaderboard(), runAgentsParallel);

    assert.equal(calls, 0, "a terminal session must not run any rounds");
    assert.equal(result.status, "converged");
    assert.equal(result.totalRounds, 4);
    assert.equal(result.bestMetric, 0.9);
    assert.equal(result.bestAgent, "modeler-classic");
    assert.equal(result.totalKeep, 2);
    assert.equal(result.totalCrash, 4);
    assert.equal(repo.finalizeStatus, null, "must not re-finalize an already-terminal session");
  });
});

// ── Failed session: stay failed, throw for retry ────────────────────────

describe("runArena — previously failed session", () => {
  it("throws instead of silently restarting a failed run", async () => {
    const ws = makeWorkspace();
    const session = makeSession({ status: "failed" });
    const repo = new FakeArenaRepo(session);
    const runAgentsParallel = async () => ({ "modeler-classic": null });

    await assert.rejects(
      runArena(makeConfig(ws), repo, makeLeaderboard(), runAgentsParallel),
      /cannot \(re\)start/,
    );
    assert.equal(repo.createCalls, 0, "a failed session must not be re-created");
  });
});

// ── Fresh run: baseline + checkpoint after round 1 ──────────────────────

describe("runArena — fresh run (no existing session)", () => {
  it("creates the session, runs all rounds, and converges", async () => {
    const ws = makeWorkspace();
    const repo = new FakeArenaRepo(null);
    const rounds: number[] = [];
    const runAgentsParallel = async () => { rounds.push(repo.session!.currentRound); return { "modeler-classic": null }; };

    const result = await runArena(makeConfig(ws), repo, makeLeaderboard(), runAgentsParallel);

    assert.equal(repo.createCalls, 1, "fresh run must create the session");
    assert.deepEqual(rounds, [1, 2, 3, 4, 5]);
    assert.equal(result.totalRounds, 5);
    assert.equal(result.status, "converged");
    assert.equal(repo.finalizeStatus, "converged");

    // Round 1's checkpoint is the compact arena state.
    const finalCp = JSON.parse(repo.checkpoint!) as CheckpointShape;
    assert.equal(finalCp.allResults.length, 5);
    assert.equal(finalCp.consecutiveNoImprove, 5);
  });
});

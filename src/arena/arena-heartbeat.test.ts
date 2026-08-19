// ══════════════════════════════════════════════════════════════════════
// arena-heartbeat.test.ts — Regression for run 9e8fa741.
//
// The control-server reconciler marks an arena step "stuck" when
// arena_sessions.updated_at is stale for ARENA_STUCK_THRESHOLD_MINUTES. On
// 9e8fa741 the arena was killed mid-generation: the agent fan-out is a pure
// LLM round-trip with no session bump until the first experiment is
// evaluated, so a slow first cycle tripped the 10-minute window. The fix is a
// session heartbeat — updateRound at round start and every heartbeatIntervalMs
// while agents generate — so the reconciler only fires when the engine is
// genuinely dead. This test proves the heartbeat fires DURING the generation
// wait, not just before and after it.
//
// runAgentsParallel is injected, so no LLM is ever called.
// ══════════════════════════════════════════════════════════════════════

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runArena } from "./arena-engine.js";
import type { ArenaRepository } from "./arena-repository.js";
import type { ArenaConfig, ArenaSession, ArenaAgentConfig } from "./arena-types.js";
import type { ArenaExperiment } from "../leaderboard/repository.js";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-hb-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeSession(): ArenaSession {
  return {
    id: "session-heartbeat",
    runId: "run-heartbeat-test",
    metricName: "f1",
    metricDirection: "higher",
    benchmarkScript: null,
    checksScript: null,
    targetMetric: null,
    maxRounds: 1,
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
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("runArena — session heartbeat during agent generation", () => {
  it("touches updateRound while agents are still generating (reconciler guard)", async () => {
    const ws = makeWorkspace();
    const session = makeSession();
    const beats: number[] = [];
    const repo: ArenaRepository = {
      getByRunId: async () => session,
      getById: async () => session,
      createFromConfig: async () => session,
      update: async () => {},
      updateRound: async () => { beats.push(Date.now()); },
      saveCheckpoint: async () => {},
      updateStats: async () => {},
      finalize: async () => { session.status = "converged"; },
      setBaseline: async () => {},
      setNoiseFloor: async () => {},
    };
    const leaderboard: {
      registrations: ArenaExperiment[];
      registerArena: (entry: ArenaExperiment) => Promise<number>;
      getBestByDatasetSignature: () => Promise<Array<{ model_type: string; hyperparameters: Record<string, unknown>; val_metric: number }>>;
    } = {
      registrations: [],
      registerArena: async () => 1,
      getBestByDatasetSignature: async () => [],
    };

    // A slow, LLM-bound generation wait: 400ms with a 20ms heartbeat gives
    // ~20 beats strictly inside the window. A null output completes the round
    // fast (agent_no_response → FAILED) so the test only exercises the guard.
    let genStart = 0;
    let genEnd = 0;
    const runAgentsParallel = async () => {
      genStart = Date.now();
      await sleep(400);
      genEnd = Date.now();
      return { "modeler-classic": null as const };
    };

    const config: ArenaConfig = {
      runId: "run-heartbeat-test",
      workspacePath: ws,
      metricName: "f1",
      metricDirection: "higher",
      maxRounds: 1,
      maxNoImprove: 5,
      commitOnKeep: false,
      revertOnDiscard: false,
      agents: [{ id: "modeler-classic", agentPersona: "modeler_classic", timeout: 300_000, strategyHint: "teste", modelType: "lightgbm" }],
      heartbeatIntervalMs: 20,
    };

    await runArena(config, repo, leaderboard, runAgentsParallel);

    // Round-start touch + a beat strictly inside the generation window.
    assert.ok(beats.length >= 2, `expected at least 2 beats, got ${beats.length}`);
    const midGen = beats.filter((b) => b > genStart && b < genEnd);
    assert.ok(
      midGen.length >= 3,
      `expected a sustained cadence while agents were generating (window ${genStart}..${genEnd}, beats: ${beats.join(",")})`,
    );
  });
});

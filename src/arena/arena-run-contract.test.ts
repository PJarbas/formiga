// ══════════════════════════════════════════════════════════════════════
// arena-run-contract.test.ts — Tests for A3/A4: the arena loop converts
// broken contracts into distinct FAILED ledger entries.
//
//   1. LLM timeout / runner failure (`output === null`) → `[agent_no_response]`
//   2. broken contract (no runnable script) → `[script_missing]`
//   3. fail-fast on strict metrics runs ONLY when the benchmark exited 0
//      and produced a metric — a missing _results.json then becomes
//      `[metrics_missing]` instead of a silent empty leaderboard row.
//   4. a runtime crash (exit ≠ 0) is a normal crash — never `[metrics_missing]`.
//
// runAgentsParallel is injected, so no LLM is ever called.
// ══════════════════════════════════════════════════════════════════════

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runArena, SCRIPT_MISSING_EXIT_CODE } from "./arena-engine.js";
import type { ArenaRepository } from "./arena-repository.js";
import type { ArenaConfig, ArenaSession, ArenaAgentConfig } from "./arena-types.js";
import type { ArenaExperiment } from "../leaderboard/repository.js";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-run-"));
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
    runId: "run-contract-test",
    workspacePath: ws,
    metricName: "f1",
    metricDirection: "higher",
    maxRounds: 1,
    maxNoImprove: 5,
    commitOnKeep: false,
    revertOnDiscard: false,
    agents: [AGENT],
  };
}

function makeSession(): ArenaSession {
  return {
    id: "session-contract",
    runId: "run-contract-test",
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

interface Harness {
  repo: ArenaRepository;
  leaderboard: {
    registrations: ArenaExperiment[];
    registerArena: (entry: ArenaExperiment) => Promise<number>;
    getBestByDatasetSignature: () => Promise<Array<{ model_type: string; hyperparameters: Record<string, unknown>; val_metric: number }>>;
  };
  stats: string[];
}

function makeHarness(): Harness {
  const session = makeSession();
  const stats: string[] = [];
  const registrations: ArenaExperiment[] = [];
  const repo: ArenaRepository = {
    getByRunId: async () => session,
    getById: async () => session,
    createFromConfig: async () => session,
    update: async () => {},
    updateRound: async () => {},
    saveCheckpoint: async () => {},
    // Mirror ArenaRepositoryImpl.updateStats so the session counters read back
    // by runArena's final getById reflect the decisions recorded.
    updateStats: async (_id, decision) => {
      stats.push(decision);
      if (decision === "keep" || decision === "baseline") session.totalKeep += 1;
      else if (decision === "discard") session.totalDiscard += 1;
      else if (decision === "crash") session.totalCrash += 1;
      else if (decision === "checks_failed") session.totalChecksFailed += 1;
    },
    finalize: async () => { session.status = "converged"; },
    setBaseline: async () => {},
    setNoiseFloor: async () => {},
  };
  return {
    repo,
    stats,
    leaderboard: {
      registrations,
      registerArena: async (entry) => { registrations.push(entry); return registrations.length; },
      getBestByDatasetSignature: async () => [],
    },
  };
}

function modelsDir(ws: string): string {
  return path.join(ws, "artifacts", "models");
}

function listScripts(ws: string): string[] {
  const dir = modelsDir(ws);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".py"));
}

// ── Guard 1: agent never responded (LLM timeout / runner failure) ───────

describe("runArena — agent_no_response (output === null)", () => {
  it("registers FAILED with [agent_no_response], exit -2, and never writes a script", async () => {
    const ws = makeWorkspace();
    const h = makeHarness();
    const runAgentsParallel = async () => ({ "modeler-classic": null });

    const result = await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);

    assert.equal(result.totalCrash, 1);
    assert.equal(h.stats.filter((s) => s === "crash").length, 1);
    assert.equal(listScripts(ws).length, 0, "no script file may be written for a dead agent");

    assert.equal(h.leaderboard.registrations.length, 1);
    const entry = h.leaderboard.registrations[0];
    assert.equal(entry.status, "FAILED");
    assert.equal(entry.decision, "crash");
    assert.equal(entry.benchmark_exit_code, SCRIPT_MISSING_EXIT_CODE);
    assert.equal(entry.measured_metric, null);
    assert.ok(entry.error_message, "expected a structured error_message");
    assert.match(entry.error_message!, /\[agent_no_response\]/);
  });
});

// ── Guard 2: contract broken — no runnable script ───────────────────────

describe("runArena — script_missing (empty script)", () => {
  it("registers FAILED with [script_missing], exit -2, and never writes a script", async () => {
    const ws = makeWorkspace();
    const h = makeHarness();
    const runAgentsParallel = async () => ({
      "modeler-classic": { script: "   \n", hypothesis: "h", learned: "", nextFocus: "" },
    });

    const result = await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);

    assert.equal(result.totalCrash, 1);
    assert.equal(listScripts(ws).length, 0, "no 0-byte artifact may be written");

    const entry = h.leaderboard.registrations[0];
    assert.equal(entry.status, "FAILED");
    assert.equal(entry.benchmark_exit_code, SCRIPT_MISSING_EXIT_CODE);
    assert.ok(entry.error_message);
    assert.match(entry.error_message!, /\[script_missing\]/);
    assert.ok(!entry.error_message!.includes("[agent_no_response]"),
      "contract break must not be confused with an LLM timeout");
  });

  it("distinguishes the two failure signatures from each other", async () => {
    const ws = makeWorkspace();
    const h = makeHarness();
    const runAgentsParallel = async () => ({
      "modeler-classic": { script: "", hypothesis: "", learned: "", nextFocus: "" },
    });
    await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);
    const entry = h.leaderboard.registrations[0];
    assert.match(entry.error_message!, /\[script_missing\]/);
    assert.notEqual(entry.error_message, "[agent_no_response] agente não respondeu dentro do timeout");
  });
});

// ── Fail-fast: only on a successful benchmark ───────────────────────────

describe("runArena — strict-metrics fail-fast (A4)", () => {
  it("fails fast to [metrics_missing] when the script exits 0 but writes no _results.json", async () => {
    const ws = makeWorkspace();
    const h = makeHarness();
    // A real quick python run: prints the metric, exits 0, never writes
    // _results.json → tryLoadRichMetrics must report [metrics_missing] and
    // the run must NOT be recorded as a silent empty success.
    const runAgentsParallel = async () => ({
      "modeler-classic": { script: 'print("f1: 0.82")', hypothesis: "h", learned: "", nextFocus: "" },
    });

    const result = await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);

    assert.equal(result.totalCrash, 1, "fail-fast must convert the empty-metrics run to a crash");
    const entry = h.leaderboard.registrations[0];
    assert.equal(entry.decision, "crash");
    assert.equal(entry.status, "FAILED");
    assert.equal(entry.measured_metric, null, "the scalar must be dropped without rich metrics");
    assert.ok(entry.error_message);
    assert.match(entry.error_message!, /\[metrics_missing\]/);
  });

  it("records a runtime crash (exit ≠ 0) WITHOUT labeling it [metrics_missing]", async () => {
    const ws = makeWorkspace();
    const h = makeHarness();
    const runAgentsParallel = async () => ({
      "modeler-classic": { script: "import sys\nsys.exit(1)", hypothesis: "h", learned: "", nextFocus: "" },
    });

    const result = await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);

    assert.equal(result.totalCrash, 1);
    const entry = h.leaderboard.registrations[0];
    assert.equal(entry.status, "FAILED");
    assert.equal(entry.benchmark_exit_code, 1);
    assert.ok(
      !entry.error_message || !entry.error_message.includes("[metrics_missing]"),
      "a legit runtime crash must never be blamed for a missing _results.json",
    );
  });

  it("keeps a genuinely successful run (exit 0 + metric + valid _results.json)", async () => {
    const ws = makeWorkspace();
    // Pre-write a valid _results.json the script will "produce".
    const dir = modelsDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "modeler-classic_round1_results.json"), JSON.stringify({
      fold_scores: [0.80, 0.82, 0.81],
      train_score: 0.85,
      roc_auc: 0.82,
      f1_score: 0.80,
      precision: 0.78,
      recall: 0.77,
      log_loss: 0.45,
    }));
    const h = makeHarness();
    const runAgentsParallel = async () => ({
      "modeler-classic": { script: 'print("f1: 0.82")', hypothesis: "h", learned: "", nextFocus: "" },
    });

    const result = await runArena(makeConfig(ws), h.repo, h.leaderboard, runAgentsParallel);

    assert.equal(result.totalCrash, 0);
    const entry = h.leaderboard.registrations[0];
    assert.notEqual(entry.status, "FAILED", "a valid run must not be marked failed");
    assert.equal(entry.measured_metric, 0.82);
    assert.ok(!entry.error_message);
  });
});

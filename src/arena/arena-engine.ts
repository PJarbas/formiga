// ════════════════════════════════════════════════════════════════════════
// arena-engine.ts — Main competition loop: fan-out agents, benchmark measure,
//                    register results, detect convergence.
// Pure orchestration logic; dependencies injected (repo, benchmark runner).
// ════════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { ArenaConfig, ArenaSession, ArenaStatus, AgentRoundResult, ArenaDecision, ArenaAgentConfig, BenchmarkResult } from "./arena-types.js";
import type { ArenaRepository } from "./arena-repository.js";
import type { ArenaExperiment } from "../leaderboard/repository.js";
import { makeDecision, isImprovement } from "./arena-decision.js";
import { extractMetric } from "./arena-benchmark.js";
import { getResultsContract, normalizeProblemType } from "./benchmark-config.js";
import { readDatasetContext, formatDatasetContextForPrompt, type DatasetContext, type ComputeBudget, deriveComputeBudget } from "./dataset-context.js";
import { auditExperiment, dedupSignature, invariant, type ComplexityTier, type AuditInput } from "./audit.js";
import { buildAgentPersonaInstructions } from "../installer/scheduler/prompts.js";

const SCRIPT_DIR = "artifacts/models";
/**
 * Wall-clock caps for script execution, with a hard floor (A6). User directive:
 * no train or benchmark script may be killed in under 5 minutes of execution,
 * in any tier. Both the budget and no-budget paths respect the floor via
 * `effectiveScriptTimeoutMs`.
 */
export const SCRIPT_TIMEOUT_FLOOR_MS = 300_000;
export const BENCHMARK_TIMEOUT_MS = 300_000;
export const TRAIN_TIMEOUT_MS = 300_000;

/**
 * Effective wall-clock timeout for a script execution (A6).
 *
 * `globalMs` is the tier-agnostic cap (TRAIN/BENCHMARK_TIMEOUT_MS). When a
 * compute budget is present, the tighter budget-derived cap
 * (`maxFitSeconds * 1000`) still applies — but never below the 5-minute floor.
 *
 * This governs the Python script running on the box. It is DISTINCT from the
 * LLM agent response timeout (`ArenaAgentConfig.timeout`, 1800s default) which
 * measures how long the agent may take to *write* the script.
 */
export function effectiveScriptTimeoutMs(
  budget: ComputeBudget | undefined,
  globalMs: number,
): number {
  if (!budget) return globalMs;
  return Math.max(SCRIPT_TIMEOUT_FLOOR_MS, Math.min(globalMs, budget.maxFitSeconds * 1000));
}
/**
 * Exit code recorded when the agent contract is broken — either the LLM
 * never responded (`[agent_no_response]`) or it returned no runnable script
 * (`[script_missing]`). Negative so it can never collide with a real process
 * exit code, keeping the ledger entry unambiguous.
 */
export const SCRIPT_MISSING_EXIT_CODE = -2;

/**
 * Kill an entire process tree (the spawned child + all its descendants).
 *
 * `child.kill(signal)` only signals the direct child — but arena scripts
 * are typically `bash -c python3 << EOF` (shell → python → possibly
 * multiprocessing workers). SIGTERM on the bash parent leaves the python
 * grandchild orphaned and running (run c682204f leaked a 55-min grid
 * search this way). Spawn with `detached: true` puts the child in its own
 * process group (pgid === child.pid); `process.kill(-pgid, signal)`
 * signals every member of that group, killing the whole tree.
 *
 * Graceful: SIGTERM first, then SIGKILL after 2s for survivors.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    // Negative pid → signal the whole process group.
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone or not detached — fall back to direct kill.
    try { child.kill(signal); } catch { /* already dead */ }
  }
}

/**
 * Ensure a detached child's process group is fully reaped after a kill.
 * SIGTERM, wait briefly, then SIGKILL if still alive. Returns a disposer
 * that clears the escalation timer (call it on normal close).
 */
function killTreeGracefully(child: ChildProcess): { cancel: () => void } {
  killProcessTree(child, "SIGTERM");
  const escalate = setTimeout(() => killProcessTree(child, "SIGKILL"), 2000);
  escalate.unref?.();
  return {
    cancel: () => clearTimeout(escalate),
  };
}

export interface ArenaResult {
  sessionId: string;
  runId: string;
  status: ArenaStatus;
  totalRounds: number;
  bestMetric: number | null;
  bestAgent: string | null;
  totalKeep: number;
  totalDiscard: number;
  totalCrash: number;
  stopReason: string;
}

/**
 * Create the models directory if it doesn't exist.
 */
function ensureScriptDir(workspacePath: string): void {
  const dir = path.join(workspacePath, SCRIPT_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Execute an agent-generated Python script to produce a trained model (.pkl).
 * Returns the path to the generated pickle, or null if training failed.
 */
/**
 * Build env vars carrying the compute budget (RF-#90). The modeler's script
 * can read these to self-calibrate (soft); the arena enforces the hard
 * limits separately (timeout + RLIMIT_CPU).
 */
function buildBudgetEnv(base: NodeJS.ProcessEnv, budget: ComputeBudget | undefined, workspacePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FORMIGA_WORKSPACE: workspacePath };
  if (budget) {
    env.FORMIGA_MAX_FIT_SECONDS = String(budget.maxFitSeconds);
    env.FORMIGA_MAX_TRIALS = String(budget.maxTrials);
    env.FORMIGA_MAX_COMBINATIONS = String(budget.maxCombinations);
    env.FORMIGA_MAX_MODEL_COMPLEXITY = budget.maxModelComplexity;
    env.FORMIGA_COMPLEXITY_TIER = budget.tier;
  }
  return env;
}

/**
 * Build a Python prelude that enforces RLIMIT_CPU (RF-#90). The modeler's
 * script path is passed as argv[1]; the prelude sets
 * `resource.setrlimit(RLIMIT_CPU, ...)` then execs the script. Exceeding
 * the CPU cap raises SIGXCPU, killing a runaway grid even if the wall-clock
 * timeout (#89) is slow. Returns null on non-POSIX platforms.
 */
export function buildRlimitPrelude(budget: ComputeBudget | undefined): string | null {
  if (!budget || process.platform === "win32") return null;
  // A6 floor: CPU-time cap never below the 5-minute wall-clock floor — the
  // tier tiny budget (maxFitSeconds=30) would otherwise SIGXCPU the process
  // at ~32s of CPU despite the 300s wall-clock window.
  const cpuSoft = Math.max(SCRIPT_TIMEOUT_FLOOR_MS / 1000, budget.maxFitSeconds);
  const cpuHard = cpuSoft + 2; // grace beyond the wall-clock timeout
  // Setrlimit caps CPU seconds; on exceed the process gets SIGXCPU.
  // The modeler script path is argv[1] (passed separately by the caller).
  return [
    "import resource as _r, sys as _s",
    `_r.setrlimit(_r.RLIMIT_CPU, (${cpuSoft}, ${cpuHard}))`,
    "_path = _s.argv[1]",
    "exec(compile(open(_path, encoding='utf-8').read(), _path, 'exec'))",
  ].join("\n");
}

async function trainScript(
  scriptPath: string,
  workspacePath: string,
  budget?: ComputeBudget,
): Promise<{ modelPath: string | null; stdout: string; stderr: string; exitCode: number | null; budgetExceeded: boolean }> {
  const expectedPkl = scriptPath.replace(/\.py$/, ".pkl");
  // Effective timeout (A6): the tighter of the global TRAIN_TIMEOUT and the
  // budget's per-fit cap, floored at 5 minutes in every tier.
  const timeoutMs = effectiveScriptTimeoutMs(budget, TRAIN_TIMEOUT_MS);
  return new Promise((resolve) => {
    // Wrap the modeler's script with a RLIMIT_CPU prelude when a budget is
    // set, so CPU-time is capped independently of the wall-clock timer.
    const prelude = buildRlimitPrelude(budget);
    const args = prelude ? ["-c", prelude, scriptPath] : [scriptPath];
    const child = spawn("python3", args, {
      cwd: workspacePath,
      shell: false,
      detached: true, // own process group → killProcessTree can reap descendants
      stdio: ["ignore", "pipe", "pipe"],
      env: buildBudgetEnv(process.env, budget, workspacePath),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let escalation: { cancel: () => void } | null = null;

    const timer = setTimeout(() => {
      killed = true;
      escalation = killTreeGracefully(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
      escalation?.cancel();
      const exitCode = killed ? null : code;
      // Look for generated .pkl at the expected path
      const modelPath = fs.existsSync(expectedPkl) ? expectedPkl : null;
      resolve({ modelPath, stdout, stderr, exitCode, budgetExceeded: killed });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      escalation?.cancel();
      console.error(`[arena-engine] child process error:`, err.stack ?? err.message);
      resolve({ modelPath: null, stdout, stderr: stderr + err.message, exitCode: null, budgetExceeded: false });
    });
  });
}

/**
 * Run a single benchmark and return the parsed result.
 */
async function benchmarkOne(
  config: ArenaConfig,
  scriptPath: string,
  budget?: ComputeBudget,
): Promise<BenchmarkResult> {
  const start = Date.now();
  // Effective timeout (A6): tighter budget cap when a budget is set, floored
  // at 5 minutes in every tier.
  const timeoutMs = effectiveScriptTimeoutMs(budget, BENCHMARK_TIMEOUT_MS);
  return new Promise((resolve) => {
    const command = `bash ${config.benchmarkScript} "${scriptPath}"`;
    const child = spawn(command, {
      cwd: config.workspacePath,
      shell: true,
      detached: true, // own process group → killProcessTree can reap descendants
      stdio: [ "ignore", "pipe", "pipe" ],
      env: buildBudgetEnv(process.env, budget, config.workspacePath),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let escalation: { cancel: () => void } | null = null;

    const timer = setTimeout(() => {
      killed = true;
      escalation = killTreeGracefully(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
      escalation?.cancel();
      // Try stdout first, then stderr (benchmark_runner.py prints to stderr)
      let metric: number | null = null;
      if (code === 0 && !killed) {
        metric = extractMetric(stdout, config.metricName);
        if (metric === null) metric = extractMetric(stderr, config.metricName);
      }
      resolve({
        metric,
        exitCode: killed ? null : code,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      escalation?.cancel();
      console.error(`[arena-engine] check child process error:`, err.stack ?? err.message);
      resolve({
        metric: null,
        exitCode: null,
        stdout,
        stderr: stderr + err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ════════════════════════════════════════════════════════════════════════
// Arena checkpoint (AL-4)
//
// The arena loop is pure in-memory orchestration — allResults, best fold
// scores, per-team budget, and dedup signatures. On daemon restart that state
// is lost and the reconciler would mark the run failed after the stuck
// threshold. To make runs resumable we persist a compact checkpoint at the
// end of every round. Only the fields the prompt builder actually reads are
// stored (benchmark stdout/stderr/duration are deliberately omitted — they're
// large and never re-read on the resume path).
// ════════════════════════════════════════════════════════════════════════

interface ArenaCheckpoint {
  version: 1;
  allResults: Array<Pick<AgentRoundResult, "agentId" | "hypothesis" | "learned" | "nextFocus" | "metric" | "decision" | "notes">>;
  bestFoldScores: number[] | null;
  teamExperimentCount: Record<string, number>;
  existingDedupSignatures: string[];
  consecutiveNoImprove: number;
}

function serializeArenaCheckpoint(state: {
  allResults: AgentRoundResult[];
  bestFoldScores: number[] | null;
  teamExperimentCount: Map<string, number>;
  existingDedupSignatures: Set<string>;
  consecutiveNoImprove: number;
}): string {
  const checkpoint: ArenaCheckpoint = {
    version: 1,
    allResults: state.allResults.map((r) => ({
      agentId: r.agentId,
      hypothesis: r.hypothesis,
      learned: r.learned,
      nextFocus: r.nextFocus,
      metric: r.metric,
      decision: r.decision,
      notes: r.notes,
    })),
    bestFoldScores: state.bestFoldScores,
    teamExperimentCount: Object.fromEntries(state.teamExperimentCount),
    existingDedupSignatures: [...state.existingDedupSignatures],
    consecutiveNoImprove: state.consecutiveNoImprove,
  };
  return JSON.stringify(checkpoint);
}

function parseArenaCheckpoint(raw: string | null | undefined): ArenaCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ArenaCheckpoint;
    if (parsed?.version !== 1 || !Array.isArray(parsed.allResults)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Race a task against a periodic heartbeat that runs until the task settles.
 * Used to keep arena_sessions.updated_at fresh while agent generation (a long,
 * LLM-bound wait) is in flight. Without it, the control-server reconciler's
 * stuck detection (session stale for ARENA_STUCK_THRESHOLD_MINUTES) would kill
 * a healthy run whose modelers are simply slow to generate — observed on run
 * 9e8fa741, where the arena was killed before its first experiment was even
 * evaluated. The timer is unref'd so it never holds the process open on its own.
 */
async function withHeartbeat<T>(
  task: () => Promise<T>,
  beat: () => Promise<void>,
  intervalMs: number,
): Promise<T> {
  const timer = setInterval(() => { void beat(); }, intervalMs);
  timer.unref?.();
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Run the full arena loop.
 */
export async function runArena(
  config: ArenaConfig,
  repo: ArenaRepository,
  leaderboardRepo: { registerArena(entry: ArenaExperiment): Promise<number>; getBestByDatasetSignature(signature: string, limit?: number): Promise<Array<{ model_type: string; hyperparameters: Record<string, unknown>; val_metric: number }>> },
  // We inject a function that runs agents in parallel and returns their outputs.
  runAgentsParallel: (
    prompts: Record<string, string>,
    config: ArenaConfig,
  ) => Promise<Record<string, { script: string; hypothesis: string; learned?: string; nextFocus?: string } | null>>
): Promise<ArenaResult> {
  ensureScriptDir(config.workspacePath);

  // In-memory loop state (declared up-front so both the create and resume
  // paths can mutate them before the round loop).
  let consecutiveNoImprove = 0;
  let stopReason = "max_rounds";
  let roundImproved = false;
  const allResults: AgentRoundResult[] = [];
  let bestFoldScores: number[] | null = null;
  const teamExperimentCount = new Map<string, number>();
  const existingDedupSignatures = new Set<string>();
  const maxIterationsPerTeam = 5;

  // 1. Resume or create session (AL-4)
  let isResume = false;
  let session: ArenaSession | null = await repo.getByRunId(config.runId);

  if (session) {
    // A terminal session means a previous run already finished the loop —
    // most likely a crash between repo.finalize and the workflow completing
    // the step. Returning the finalized result lets the workflow advance the
    // step instead of replaying (or worse, re-running baseline, which would
    // wipe best_metric). A failed session stays a failure: throw so the
    // workflow marks the step failed for retry.
    if (session.status === "converged" || session.status === "target_reached" || session.status === "max_rounds") {
      return {
        sessionId: session.id,
        runId: session.runId,
        status: session.status,
        totalRounds: session.currentRound,
        bestMetric: session.bestMetric,
        bestAgent: session.bestAgent,
        totalKeep: session.totalKeep,
        totalDiscard: session.totalDiscard,
        totalCrash: session.totalCrash,
        stopReason: session.status,
      };
    }
    if (session.status !== "running") {
      throw new Error(`Arena session ${config.runId} is ${session.status} — cannot (re)start`);
    }
    // Resume path: restore the in-memory loop state from the last checkpoint.
    // Baseline is NOT re-established — setBaseline would wipe best_metric, and
    // the persisted baseline_metric is already loaded with the session.
    isResume = true;
    const checkpoint = parseArenaCheckpoint(session.stateJson);
    if (checkpoint) {
      for (const r of checkpoint.allResults) {
        allResults.push({
          ...r,
          durationMs: 0,
          benchmarkStdout: "",
          benchmarkStderr: "",
          benchmarkExitCode: null,
          scriptPath: "",
        });
      }
      bestFoldScores = checkpoint.bestFoldScores;
      for (const [agentId, count] of Object.entries(checkpoint.teamExperimentCount)) teamExperimentCount.set(agentId, count);
      for (const sig of checkpoint.existingDedupSignatures) existingDedupSignatures.add(sig);
      consecutiveNoImprove = checkpoint.consecutiveNoImprove;
      console.log("[arena-engine] resume", { runId: config.runId, fromRound: session.currentRound, restoredResults: allResults.length });
    } else {
      // Crash before the first checkpoint was written: the session row exists
      // but holds no resumable state. Restart the loop from currentRound+1;
      // for a pristine session that is round 1 with best_metric=null, which
      // reproduces a fresh start.
      console.warn("[arena-engine] resume without checkpoint — restarting loop", { runId: config.runId, currentRound: session.currentRound });
    }
  } else {
    // Fresh run: create the session row.
    session = await repo.createFromConfig(config.runId, config);
  }

  // 2. Establish baseline from benchmark_config.json or by running benchmark
  //    script. Skipped entirely on resume — setBaseline would wipe best_metric,
  //    and the persisted baseline_metric is already loaded with the session.
  let baselineMetric: number | null = null;
  if (!isResume) {
    // Try reading baseline from config first (most reliable)
    const benchmarkConfigPaths = [
      path.join(config.workspacePath, "benchmark_config.json"),
      path.join(config.workspacePath, "artifacts", "benchmark_config.json"),
    ];
    for (const cfgPath of benchmarkConfigPaths) {
      if (fs.existsSync(cfgPath)) {
        try {
          const cfgRaw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          const baselineCfg = cfgRaw.baseline;
          if (baselineCfg) {
            // Look for cv_rmse_mean, cv_<metric>_mean, or any metric value
            const metricKey = `cv_${config.metricName.toLowerCase()}_mean`;
            baselineMetric = baselineCfg[metricKey] ?? baselineCfg.cv_rmse_mean ?? baselineCfg.metric ?? null;
          }
        } catch { /* ignore parse errors */ }
        break;
      }
    }
  }
  // Read dataset context once for the entire arena run
  const datasetCtx = readDatasetContext(config.workspacePath);
  // Derive the enforceable compute budget from the tier (RF-#90). Passed to
  // trainScript/benchmarkOne so runaway scripts (e.g. a 6480-combo grid on
  // a 150-row dataset) are killed by timeout + RLIMIT_CPU, not just advised.
  const budget = deriveComputeBudget(datasetCtx.complexityTier);

  // Fallback: run benchmark with baseline .pkl if no config baseline (fresh runs only)
  if (!isResume && baselineMetric === null) {
    const baselinePkl = path.join(config.workspacePath, "artifacts", "baseline.pkl");
    if (fs.existsSync(baselinePkl)) {
      const baseline = await benchmarkOne(config, baselinePkl, budget);
      baselineMetric = baseline.metric;
    }
  }
  if (!isResume && baselineMetric !== null) {
    await repo.setBaseline(session.id, baselineMetric);
    session.baselineMetric = baselineMetric;
    session.bestMetric = baselineMetric;
  }

  // ── Tier gate for the creative team (ISSUE-10) ──
  // The 3rd team (modeler-creative) explores decorrelation-seeking approaches
  // (DAE, aggressive mRMR, etc.) whose ROI is negative on small datasets —
  // they overfit or burn budget without diversity benefit. Only activate it
  // on MEDIUM/LARGE tiers. The two standard teams always run.
  const activeAgents = (datasetCtx.complexityTier === "medium" || datasetCtx.complexityTier === "large")
    ? config.agents
    : config.agents.filter((a) => a.id !== "modeler-creative");

  // ── Provisioned personas (contract A1) ──
  // Load each active agent's persona once, before the round loop. Persona
  // files live under ~/.formiga/workspaces/workflows/<workflowId>_<persona>/
  // and are injected into the prompt as authority — but the JSON output
  // contract below always overrides any output format the persona mentions.
  // buildAgentPersonaInstructions returns "" when no files are provisioned,
  // so agents still run with the built-in strategy hints (graceful fallback).
  const agentPersonas: Record<string, string> = {};
  for (const agent of activeAgents) {
    const formigaAgentId = `${config.workflowId ?? "ml-autoresearch"}_${agent.agentPersona}`;
    try {
      agentPersonas[agent.id] = await buildAgentPersonaInstructions(formigaAgentId);
    } catch (err) {
      agentPersonas[agent.id] = "";
      console.error("[arena-engine] persona load failed", { agentId: agent.id, error: String(err) });
    }
  }

  // Warm-start: inject past best results for this dataset signature
  let warmStartHints: string[] = [];
  if (config.datasetSignature) {
    try {
      const pastBest = await leaderboardRepo.getBestByDatasetSignature(config.datasetSignature, 3);
      warmStartHints = pastBest.map((r, i) =>
        `  ${i + 1}. ${r.model_type} (val_metric=${r.val_metric}) — ${JSON.stringify(r.hyperparameters)}`
      );
    } catch { /* best-effort: warm-start is optional */ }
  }

  // ── content_hash: intra-run dataset integrity anchor ──
  // MD5(features ‖ split ‖ config) computed by the feature-engineer. The
  // auditor (gate G2) rejects experiments whose hash does not match the
  // session's — catches stale-dataset submissions after features are rebuilt.
  const sessionContentHash = readSessionContentHash(config.workspacePath);

  // ── Failed-attempt ledger helper (contract A4) ──
  // One uniform FAILED registration for every failure mode (agent_no_response,
  // script_missing, strict-metrics fail-fast, runtime crash, timeout kill).
  // `rich` is best-effort — a partially written _results.json can still carry
  // useful fields (hyperparameters, fold_scores, …).
  async function registerFailedArena(p: RegisterFailedArenaParams): Promise<void> {
    const { agent, round, config, datasetCtx, result, bench, rich, errorMessage, sessionContentHash } = p;
    const experimentId = await leaderboardRepo.registerArena({
      run_id: config.runId,
      round_number: round,
      agent_name: agent.id,
      model_type: agent.modelType ?? agent.id,
      model_algorithm: rich?.modelAlgorithm ?? agent.modelType ?? agent.id,
      hyperparameters: rich?.hyperparameters ?? {},
      hypothesis: result.hypothesis || null,
      learned: result.learned || null,
      next_focus: result.nextFocus || null,
      measured_metric: null, // explicit — a failure has no metric
      benchmark_stdout: bench?.stdout ?? result.benchmarkStdout,
      benchmark_stderr: errorMessage
        ? (bench ? `${bench.stderr}\n${errorMessage}` : errorMessage).trim()
        : bench?.stderr ?? result.benchmarkStderr,
      benchmark_exit_code: bench?.exitCode ?? result.benchmarkExitCode ?? null,
      error_message: errorMessage ?? null,
      decision: "crash",
      duration_ms: bench?.durationMs ?? result.durationMs,
      artifact_script: result.scriptPath || null,
      metric_name: config.metricName,
      artifact_path: result.scriptPath,
      metric_bag: rich?.metricBag,
      problem_type: datasetCtx.problemType,
      status: "FAILED",
      fold_scores: rich?.foldScores,
      train_score: rich?.trainScore ?? null,
      content_hash: sessionContentHash,
      oof_artifact_key: rich?.oofArtifactKey ?? null,
      prod_artifact_key: rich?.prodArtifactKey ?? null,
      brier_raw: rich?.brierRaw ?? null,
      brier_calibrated: rich?.brierCalibrated ?? null,
      ece_calibrated: rich?.eceCalibrated ?? null,
      notes: rich?.notes ?? null,
      category: rich?.category ?? null,
      feature_importances: rich?.featureImportances ?? null,
    });
    result.experimentId = experimentId;
  }

  // 3. Round loop — resumes from the last completed round on a restarted run
  const startRound = session.currentRound + 1;
  for (let round = startRound; round <= config.maxRounds; round++) {
    session.currentRound = round;

    // Build prompts with dataset context for complexity-aware generation
    const prompts = buildPromptsForRound(config, session, allResults, datasetCtx, warmStartHints, activeAgents, agentPersonas);

    // ── Session heartbeat (reconciler stuck-detection guard) ─────────────
    // The session normally bumps on experiment evaluation (updateStats) and at
    // round end, but the agent generation wait below is a pure LLM round-trip
    // that can take well over 10 minutes. Touch the session at round start and
    // every few minutes while agents generate, so the reconciler only marks the
    // step stuck when the engine is genuinely dead. Idempotent: updateRound
    // rewrites the in-memory round state unchanged.
    const touchSession = async (): Promise<void> => {
      try {
        await repo.updateRound(
          session.id,
          session.currentRound,
          session.bestMetric,
          session.bestAgent,
          session.bestExperimentId,
          session.consecutiveNoImprove,
        );
      } catch {
        // Best effort — a failed heartbeat must never kill the arena.
      }
    };
    await touchSession();

    // Fan-out: run all agents in parallel
    const agentOutputs = await withHeartbeat(
      () => runAgentsParallel(prompts, config),
      touchSession,
      config.heartbeatIntervalMs ?? 3 * 60 * 1000,
    );

    // Measure sequentially (resource contention)
    const roundResults: AgentRoundResult[] = [];
    roundImproved = false;
    for (const agent of activeAgents) {
      const output = agentOutputs[agent.id];
      const scriptPath = path.join(config.workspacePath, SCRIPT_DIR, `${agent.id}_round${round}.py`);

      // Resolve the runnable script. Precedence:
      //   1. parsed from the agent's response text (output.script)
      //   2. the file the agent wrote to the canonical path. pi --mode json
      //      streams scripts through bash toolCalls, so the response text the
      //      extractor rebuilds rarely contains them — the on-disk file (the
      //      path the prompt mandates the agent save to) is the reliable
      //      source of truth, including when the run timed out mid-stream
      //      after the file was already written.
      let script = output?.script?.trim() ?? "";
      if (!script) {
        try {
          if (fs.existsSync(scriptPath)) {
            const onDisk = fs.readFileSync(scriptPath, "utf-8").trim();
            if (onDisk.length > 0) script = onDisk;
          }
        } catch {
          // best effort — fall through to the guard below
        }
      }

      // Guard — no runnable script anywhere: neither in the response text nor
      // on disk. Distinguish a runner failure (never responded) from a
      // contract break (responded without a script). Registered as FAILED
      // with benchmark_exit_code = -2 so the leaderboard distinguishes a dead
      // agent from a real runtime crash.
      if (!script) {
        const reason = output
          ? "[script_missing] agente não retornou script executável no JSON de resposta"
          : "[agent_no_response] agente não respondeu dentro do timeout";
        const r = createCrashResult(agent.id, reason, SCRIPT_MISSING_EXIT_CODE);
        r.benchmarkStderr = reason;
        await registerFailedArena({
          agent,
          round,
          config,
          datasetCtx,
          result: r,
          errorMessage: reason,
          sessionContentHash,
        });
        roundResults.push(r);
        await repo.updateStats(session.id, "crash");
        continue;
      }

      // Canonicalize the resolved script (idempotent when read from disk).
      fs.writeFileSync(scriptPath, script, "utf-8");

      // Execute the agent's script directly — it trains, evaluates, and prints metric
      const exec = await trainScript(scriptPath, config.workspacePath, budget);
      const combinedOutput = exec.stdout + "\n" + exec.stderr;
      const metric = exec.exitCode === 0 ? extractMetric(combinedOutput, config.metricName) : null;
      const bench: BenchmarkResult = {
        metric,
        exitCode: exec.exitCode,
        stdout: exec.stdout,
        stderr: exec.stderr,
        durationMs: 0,
      };
      const decision = bench.exitCode === 0 && bench.metric !== null
        ? makeDecision(bench.metric, session.bestMetric, config.metricDirection, session.baselineMetric)
        : "crash";

      const result: AgentRoundResult = {
        agentId: agent.id,
        // output may be null here when the script was rescued from disk after
        // a runner timeout — fall back to empty text fields.
        hypothesis: output?.hypothesis ?? "",
        learned: output?.learned ?? "",
        nextFocus: output?.nextFocus ?? "",
        metric: bench.metric,
        decision,
        durationMs: bench.durationMs,
        benchmarkStdout: bench.stdout,
        benchmarkStderr: bench.stderr,
        benchmarkExitCode: bench.exitCode,
        budgetExceeded: exec.budgetExceeded,
        scriptPath: scriptPath.replace(config.workspacePath + path.sep, ""),
      };

      roundResults.push(result);

      const richLoad = tryLoadRichMetrics(config.workspacePath, agent.id, round, datasetCtx.problemType);
      const richMetrics = richLoad.rich;
      // Surface the cross-pollination note on the in-memory result so the
      // next round's prompt can inject it for the other team(s).
      result.notes = richMetrics.notes ?? undefined;

      // ── Fail-fast on strict metrics (contract A4) ──
      // A benchmark that EXITED 0 and produced a parsable metric MUST also
      // produce a valid _results.json — otherwise the leaderboard renders
      // empty metrics for a "successful" run (the user-visible bug). Legit
      // crashes never reach this branch: timeout kill → exitCode null,
      // runtime failure → exitCode ≠ 0, both skip fail-fast (a missing
      // _results.json is expected there, not a contract violation).
      if (richLoad.error !== null && bench.exitCode === 0 && bench.metric !== null) {
        const reason = richLoad.error;
        result.decision = "crash";
        result.metric = null; // drop the scalar — no rich metrics back it up
        result.benchmarkStderr = (bench.stderr + "\n" + reason).trim();
        result.benchmarkStdout = bench.stdout;
        result.benchmarkExitCode = bench.exitCode;
        // Fail-fast still consumes a team slot (it ran, just broke the
        // metrics contract) but never triggers dedup tracking.
        teamExperimentCount.set(agent.id, (teamExperimentCount.get(agent.id) ?? 0) + 1);
        await registerFailedArena({
          agent,
          round,
          config,
          datasetCtx,
          result,
          bench,
          rich: richMetrics,
          errorMessage: reason,
          sessionContentHash,
        });
        await repo.updateStats(session.id, "crash");
        continue;
      }

      // ── Pre-write audit ───────────────────────────────────────────────
      // Run the blocking quality gates BEFORE persisting. The audit may
      // override the raw `makeDecision` verdict: a metric that "improves" on
      // the scalar comparison can still be REJECTED (overfit, stale dataset,
      // no folds, cal leak, budget) or downgraded to `warn` (not statistically
      // significant). REJECTED entries are still written to the ledger for
      // transparency, with a structured rejection_reason.
      const tier = mapTier(datasetCtx.complexityTier);

      // ── Pre-write audit (narrowed) ───────────────────────────────────────
      // The condition directly narrows bench.metric: inside the success branch
      // TypeScript treats bench.metric as `number` (no `as number` cast needed).
      // The crash branch never touches bench.metric for arithmetic, so the
      // "null.toFixed()" class of bugs is structurally impossible.
      //
      // Crashes are still registered in the leaderboard for transparency but
      // skip quality gates and dedup tracking (null metrics shouldn't dedup).
      let auditedDecision: ArenaDecision;
      let auditedStatus: string | undefined;
      let rejectionReason: string | null = null;
      let iterationTeam = (teamExperimentCount.get(agent.id) ?? 0) + 1;
      let isDuplicate = false;

      if (bench.metric !== null && bench.exitCode === 0) {
        // ✅ bench.metric narrowed to `number` — safe for all arithmetic.
        const metric: number = bench.metric;

        const audit = auditExperiment({
          metric,
          trainScore: richMetrics.trainScore ?? null,
          foldScores: richMetrics.foldScores ?? null,
          bestFoldScores,
          bestMetric: session.bestMetric,
          contentHash: sessionContentHash,
          sessionContentHash,
          oofUniqueProbs: richMetrics.oofUniqueProbs ?? null,
          eceCalibrated: richMetrics.eceCalibrated ?? null,
          maxUnivariateAuc: null, // populated by feature-engineer gate (ISSUE-07)
          teamExperimentCount: teamExperimentCount.get(agent.id) ?? 0,
          maxIterationsPerTeam,
          problemType: datasetCtx.problemType,
          metricName: config.metricName,
          tier,
          direction: config.metricDirection,
          dedupSignature: dedupSignature(
            agent.id,
            agent.modelType ?? agent.id,
            richMetrics.hyperparameters ?? {},
            metric,
          ),
          existingDedupSignatures,
        });
        iterationTeam = audit.iterationTeam;

        if (audit.verdict === "rejected") {
          // All gate rejections (overfit, no_folds, cal_leak, budget, stale)
          // are recorded as checks_failed + OVERFITTED — distinguishable
          // from genuine crashes (decision=crash + status=FAILED).
          auditedDecision = "checks_failed";
          auditedStatus = "OVERFITTED";
          rejectionReason = audit.rejectionReason;
          isDuplicate = audit.rejectionReason?.startsWith("[dedup]") ?? false;
        } else if (audit.verdict === "warn") {
          // Statistically non-significant: keep on the ledger but do not promote.
          auditedDecision = "discard";
          auditedStatus = "SUCCESS";
        } else {
          // keep — promoted as a new best candidate.
          auditedDecision = session.bestMetric === null ? "baseline" : "keep";
          auditedStatus = "AUDITED";
        }

        // A non-dedup experiment counts toward the team budget.
        if (!isDuplicate) {
          teamExperimentCount.set(agent.id, (teamExperimentCount.get(agent.id) ?? 0) + 1);
        }

        // Register in leaderboard + track dedup signature ONLY for successes.
        // Dedup is the ONLY place where metric enters the signature — crashes
        // never produce dedup entries.
        let experimentId: number | undefined;
        if (!isDuplicate) {
          experimentId = await leaderboardRepo.registerArena({
            run_id: config.runId,
            round_number: round,
            agent_name: agent.id,
            model_type: agent.modelType ?? agent.id,
            model_algorithm: richMetrics.modelAlgorithm ?? agent.modelType ?? agent.id,
            hyperparameters: richMetrics.hyperparameters ?? {},
            hypothesis: output?.hypothesis ?? "",
            learned: output?.learned ?? "",
            next_focus: output?.nextFocus ?? "",
            measured_metric: metric,
            benchmark_stdout: bench.stdout,
            benchmark_stderr: bench.stderr,
            benchmark_exit_code: bench.exitCode,
            decision: auditedDecision,
            duration_ms: bench.durationMs,
            artifact_script: result.scriptPath,
            metric_name: config.metricName,
            artifact_path: result.scriptPath,
            metric_bag: richMetrics.metricBag,
            problem_type: datasetCtx.problemType,
            status: auditedStatus,
            fold_scores: richMetrics.foldScores,
            train_score: richMetrics.trainScore ?? null,
            content_hash: sessionContentHash,
            oof_artifact_key: richMetrics.oofArtifactKey ?? null,
            prod_artifact_key: richMetrics.prodArtifactKey ?? null,
            brier_raw: richMetrics.brierRaw ?? null,
            brier_calibrated: richMetrics.brierCalibrated ?? null,
            ece_calibrated: richMetrics.eceCalibrated ?? null,
            notes: richMetrics.notes ?? null,
            category: richMetrics.category ?? null,
            feature_importances: richMetrics.featureImportances ?? null,
            iteration_team: iterationTeam,
          });
          // Track dedup signature — metric is guaranteed non-null by the
          // outer `if` condition that narrowed bench.metric to `number`.
          existingDedupSignatures.add(
            dedupSignature(agent.id, agent.modelType ?? agent.id, richMetrics.hyperparameters ?? {}, metric),
          );
        }
        result.experimentId = experimentId;
      } else {
        // Crash path: metric is null or exitCode ≠ 0.
        // No quality gates, no dedup tracking. Still register for transparency.
        auditedDecision = "crash";
        auditedStatus = "FAILED";

        // Crashes still consume a team slot (transparency).
        teamExperimentCount.set(agent.id, (teamExperimentCount.get(agent.id) ?? 0) + 1);

        // Timeout/budget kills get a structured reason so the leaderboard
        // distinguishes them from a plain runtime crash. A missing
        // _results.json is EXPECTED here (the script died before writing) —
        // never labeled [metrics_missing] (contract A4).
        const errorMessage = exec.budgetExceeded
          ? "[timeout_budget] script excedeu o limite de tempo de execução e foi encerrado"
          : null;

        await registerFailedArena({
          agent,
          round,
          config,
          datasetCtx,
          result,
          bench,
          rich: richMetrics,
          errorMessage,
          sessionContentHash,
        });
        // No dedup tracking — null metrics are never duplicates.
      }
      result.decision = auditedDecision;

      // Update session state — only a genuine `keep`/`baseline` (statistically
      // significant) promotes the best. No-improve is tracked per-round below
      // so that multiple agents competing in the same round each get a fair
      // chance before the arena converges.
      const improved = result.decision === "keep" || result.decision === "baseline";
      if (improved && result.metric !== null) {
        session.bestMetric = result.metric;
        session.bestAgent = agent.id;
        session.bestExperimentId = result.experimentId ?? null;
        // Capture fold scores of the new best for the next Nadeau-Bengio test.
        bestFoldScores = richMetrics.foldScores ?? null;
        roundImproved = true;
      }
      session.consecutiveNoImprove = consecutiveNoImprove;

      // Update repo stats
      await repo.updateStats(session.id, result.decision);
    }

    // Per-round no-improve accounting: a round counts as "improved" if
    // at least one agent produced a keep/baseline. This gives every
    // competing agent a fair number of attempts before convergence.
    if (roundImproved) {
      consecutiveNoImprove = 0;
    } else {
      consecutiveNoImprove++;
    }
    session.consecutiveNoImprove = consecutiveNoImprove;

    // Persist round result + resume checkpoint (AL-4). The checkpoint is
    // saved BEFORE advancing current_round: a crash between the two leaves
    // current_round one behind the checkpoint, which replays the round on
    // resume (at-least-once) rather than silently skipping it.
    allResults.push(...roundResults);
    await repo.saveCheckpoint(session.id, serializeArenaCheckpoint({
      allResults,
      bestFoldScores,
      teamExperimentCount,
      existingDedupSignatures,
      consecutiveNoImprove,
    }));
    await repo.updateRound(session.id, round, session.bestMetric, session.bestAgent, null, consecutiveNoImprove);

    // Emit event
    emitArenaEvent(config.runId, round, roundResults, session);

    // Convergence checks
    const targetReached = config.targetMetric !== undefined && session.bestMetric !== null && isImprovement(session.bestMetric, config.targetMetric, config.metricDirection);
    if (targetReached) {
      stopReason = "target_reached";
      await repo.finalize(session.id, "target_reached");
      break;
    }

    if (consecutiveNoImprove >= config.maxNoImprove) {
      stopReason = "converged";
      await repo.finalize(session.id, "converged");
      break;
    }
  }

  if (stopReason === "max_rounds") {
    await repo.finalize(session.id, "max_rounds");
  }

  const finalSession = await repo.getById(session.id);
  if (!finalSession) throw new Error("Session disappeared during arena run");

  return {
    sessionId: finalSession.id,
    runId: finalSession.runId,
    status: finalSession.status,
    totalRounds: finalSession.currentRound,
    bestMetric: finalSession.bestMetric,
    bestAgent: finalSession.bestAgent,
    totalKeep: finalSession.totalKeep,
    totalDiscard: finalSession.totalDiscard,
    totalCrash: finalSession.totalCrash,
    stopReason,
  };
}

function buildPromptsForRound(
  config: ArenaConfig,
  session: ArenaSession,
  allResults: AgentRoundResult[],
  datasetCtx: DatasetContext,
  warmStartHints: string[] = [],
  // Active agents for this run (may exclude modeler-creative on TINY/SMALL
  // tiers — see the tier gate in runArena). Defaults to all configured agents.
  activeAgents: ArenaAgentConfig[] = config.agents,
  // Provisioned persona text per agent id (empty string = none). Loaded once
  // by runArena and injected as authority right after the strategy hint.
  agentPersonas: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const prompts: Record<string, string> = {};

  // Build a simple leaderboard from allResults (kept + baseline items)
  const kept = allResults.filter(r => r.decision === "keep" || r.decision === "baseline");
  const bestByAgent = new Map<string, AgentRoundResult>();
  for (const r of kept) {
    const prev = bestByAgent.get(r.agentId);
    if (!prev || (r.metric !== null && prev.metric !== null && r.metric > prev.metric)) {
      bestByAgent.set(r.agentId, r);
    }
  }

  for (const agent of activeAgents) {
    const myHistory = allResults.filter(r => r.agentId === agent.id);
    const othersKept = allResults.filter(r => r.agentId !== agent.id && (r.decision === "keep" || r.decision === "baseline"));

    let prompt = `## Arena de Competição — Rodada ${session.currentRound}\n\n`;
    prompt += `Você é ${agent.id}. Supere o melhor atual.\n\n`;
    prompt += `**IMPORTANTE**: Todas as suas respostas devem ser em português brasileiro.\n\n`;
    // Inject dataset context with complexity gates
    prompt += formatDatasetContextForPrompt(datasetCtx, agent.id);
    prompt += `\n`;
    prompt += `### Melhor Atual\n`;
    prompt += `Métrica: ${session.bestMetric ?? "N/A"} (${config.metricDirection === "lower" ? "menor" : "maior"} é melhor)\n`;
    prompt += `Meta: ${config.targetMetric ?? "nenhuma"}\n\n`;
    prompt += `### Seu Histórico\n`;
    if (myHistory.length === 0) prompt += "(nenhum ainda)\n";
    else {
      for (const h of myHistory) {
        prompt += `  Rodada ${session.currentRound - 1}: ${h.hypothesis} → ${h.metric !== null ? h.metric.toFixed(6) : "falha"} (${h.decision})\n`;
      }
    }
    prompt += `\n### Resultados Mantidos de Outros\n`;
    if (othersKept.length === 0) prompt += "(nenhum ainda)\n";
    else {
      for (const o of othersKept) {
        prompt += `  ${o.agentId}: "${o.hypothesis}" → ${o.metric !== null ? o.metric.toFixed(6) : "falha"}\n`;
      }
    }
    // ── Cross-pollination: notes the other team(s) directed at you ──
    // Distinct from their `learned` (own reflection) — these are explicit
    // suggestions for you. Incentivizes teams to build on each other's
    // findings.
    const othersNotes = othersKept
      .filter((o) => o.notes && o.notes.trim().length > 0)
      .map((o) => `  ${o.agentId}: ${o.notes!.trim()}`);
    if (othersNotes.length > 0) {
      prompt += `\n### Sugestões do Outro Time (cross-pollination)\n`;
      prompt += othersNotes.join("\n") + "\n";
      prompt += `Considere essas sugestões ao formular sua hipótese — você pode explorá-las ou refutá-las.\n`;
    }
    prompt += `\n### Estratégia\n${agent.strategyHint}\n\n`;
    // ── Provisioned persona (contract A1) ──
    // The persona is authority for HOW to approach the problem, but its
    // "Formato de Saída" (if any) is always overridden by the JSON response
    // contract below — never emit HIPOTESE/SCRIPT_PATH/... markers.
    const persona = agentPersonas[agent.id] ?? "";
    if (persona.trim().length > 0) {
      prompt += `### Persona Provisionada (autoridade)\n${persona}\n\n`;
      prompt += `**IMPORTANTE**: qualquer "Formato de Saída" citado na persona foi SUBSTITUÍDO pela seção "Formato de Resposta JSON" abaixo. Siga o JSON, não os marcadores da persona.\n\n`;
    }
    if (warmStartHints.length > 0 && session.currentRound === 1) {
      prompt += `### Warm-Start: Melhores Anteriores para Este Dataset\n`;
      prompt += warmStartHints.join("\n") + "\n\n";
    }
    // Formiga dashboard persistence: the pi extension exposes native tools
    // (save_artifact / log_decision / report_metric / query_leaderboard). Do NOT
    // inject curl/bash helpers here — they bypass the tool system, carry the
    // wrong step attribution, and miss the dashboard auth header.
    prompt += `### Formiga Dashboard (persistência de artefatos)\n\n`;
    prompt += `Use as ferramentas nativas da extensão formiga-agent-tools (disponíveis nesta sessão) para persistir saídas no dashboard — NUNCA use curl/bash para isso:\n\n`;
    prompt += `  - save_artifact({ key, data })   Persiste JSON estruturado (EDA report, features metadata, baseline submission, configs)\n`;
    prompt += `  - report_metric({ name, value, tags? })   Reporta métricas numéricas (CV score, tempos, contagens)\n`;
    prompt += `  - log_decision({ decision_type, description, reasoning? })   Registra decisões para auditoria/explicabilidade\n`;
    prompt += `  - query_leaderboard({ limit? })  Lê o estado atual do leaderboard\n\n`;
    prompt += `Artefatos de etapas anteriores estão disponíveis em disco sob \`artifacts/\` — use as ferramentas de leitura de arquivo para consultá-los.\n\n`;
    prompt += `**Artefatos disponíveis:** eda_config, eda_report, features_metadata, baseline_submission, split_config, benchmark_config\n\n`;

    prompt += `### Regras\n`;
    prompt += `- Escreva um script Python AUTÔNOMO que treina um modelo e o avalia.\n`;
    prompt += `- O script deve ler benchmark_config.json da raiz do workspace.\n`;
    prompt += `- Use validação cruzada com a mesma configuração (mesmos splits, mesma métrica).\n`;
    prompt += `- No final, imprima EXATAMENTE esta linha no stdout: ${config.metricName}: <valor_numerico>\n`;
    prompt += `- Exemplo de saída: ${config.metricName}: 4500.1234\n`;
    prompt += `- Salve também seu modelo treinado como: artifacts/models/${agent.id}_round${session.currentRound}.pkl\n`;
    prompt += `- Salve o script em: artifacts/models/${agent.id}_round${session.currentRound}.py\n`;
    prompt += `- Salve também um arquivo JSON com informações detalhadas do modelo e métricas ricas de validação cruzada em: artifacts/models/${agent.id}_round${session.currentRound}_results.json\n`;
    prompt += `  **CRÍTICO**: O seu script Python DEVE salvar o arquivo JSON de métricas ricas com a estrutura exata abaixo. Se você não criar o arquivo JSON ou salvá-lo com formato incorreto, sua rodada falhará no dashboard. Calcule e salve as métricas usando validação cruzada (média entre os folds).\n\n`;
    if (getResultsContract(datasetCtx.problemType) === "classification") {
      prompt += `  O JSON deve ter EXATAMENTE esta estrutura:\n`;
      prompt += `  {\n`;
      prompt += `    "model": "<classe_do_algoritmo_ex_XGBClassifier_ou_SVC>",\n`;
      prompt += `    "best_params": { ..._parâmetros_de_hiperparametrização_... },\n`;
      prompt += `    "f1_score": <float_ou_null_f1_macro_ou_f1>,\n`;
      prompt += `    "precision": <float_ou_null_precision_macro>,\n`;
      prompt += `    "recall": <float_ou_null_recall_macro>,\n`;
      prompt += `    "roc_auc": <float_ou_null_roc_auc_ou_roc_auc_ovr>,\n`;
      prompt += `    "log_loss": <float_ou_null_neg_log_loss_invertido_sinal>,\n`;
      prompt += `    "fold_scores": [<float>, ...],  // OBRIGATÓRIO: score de cada fold da CV (ex: [0.81, 0.79, 0.82, 0.80, 0.83]). Sem isso o experimento é rejeitado [no_folds].\n`;
      prompt += `    "train_score": <float>,         // OBRIGATÓRIO: métrica no treino (para gate de overfitting). gap > threshold → rejeitado [overfit].\n`;
      prompt += `    "oof_path": "<string_ou_null>",  // caminho do _oof.npy (probabilidades out-of-fold). Necessário p/ ensemble e detecção de cal-leak.\n`;
      prompt += `    "prod_path": "<string_ou_null>", // caminho do _prod.pkl (modelo refitado em 100% não-OOT).\n`;
      prompt += `    "brier_raw": <float_ou_null>,\n`;
      prompt += `    "brier_calibrated": <float_ou_null>,\n`;
      prompt += `    "ece_calibrated": <float_ou_null>,  // ECE com bins de QUANTIL (não equal-width). Robusto a colapso de probs.\n`;
      prompt += `    "n_unique_probs": <int_ou_null>,   // nº de probabilidades únicas no array OOF. <50 = saturação (rejeitado [cal_leak]).\n`;
      prompt += `    "category": "<hyperparameter|feature_engineering|ensemble|model_selection|regularization|calibration>",\n`;
      prompt += `    "notes": "<string_ou_null>"  // cross-pollination: sugestão/observação dirigida AO OUTRO time (ex: "MLP com embedding de X pode extrair interações"). Distinto de learned.\n`;
      prompt += `  }\n\n`;
      prompt += `  Exemplo de código para salvar o JSON no final do seu script:\n`;
      prompt += `  \`\`\`python\n`;
      prompt += `  import json, numpy as np\n`;
      prompt += `  # Calcule as métricas ricas usando cross_validate com a mesma estratégia de splits (CV)\n`;
      prompt += `  # fold_scores = lista com o score de CADA fold (não a média!)\n`;
      prompt += `  results = {\n`;
      prompt += `      "model": type(model).__name__ if not hasattr(model, "steps") else type(model.steps[-1][1]).__name__,\n`;
      prompt += `      "best_params": model.get_params() if not hasattr(model, "steps") else model.steps[-1][1].get_params(),\n`;
      prompt += `      "f1_score": float(f1_score),\n`;
      prompt += `      "precision": float(precision),\n`;
      prompt += `      "recall": float(recall),\n`;
      prompt += `      "roc_auc": float(roc_auc),\n`;
      prompt += `      "log_loss": float(log_loss),\n`;
      prompt += `      "fold_scores": [float(s) for s in fold_scores],\n`;
      prompt += `      "train_score": float(train_score),\n`;
      prompt += `      "oof_path": "artifacts/models/${agent.id}_round${session.currentRound}_oof.npy",\n`;
      prompt += `      "prod_path": "artifacts/models/${agent.id}_round${session.currentRound}_prod.pkl",\n`;
      prompt += `      "brier_raw": float(brier_raw) if brier_raw is not None else None,\n`;
      prompt += `      "brier_calibrated": float(brier_cal) if brier_cal is not None else None,\n`;
      prompt += `      "ece_calibrated": float(ece_cal) if ece_cal is not None else None,  # ECE com bins de QUANTIL\n`;
      prompt += `      "n_unique_probs": int(np.unique(oof_probs).size) if oof_probs is not None else None,\n`;
      prompt += `      "category": "hyperparameter",\n`;
      prompt += `      "notes": "Sugestão para o outro time: ..."  # cross-pollination (opcional)\n`;
      prompt += `  }\n`;
      prompt += `  np.save("artifacts/models/${agent.id}_round${session.currentRound}_oof.npy", oof_probs)\n`;
      prompt += `  with open("artifacts/models/${agent.id}_round${session.currentRound}_results.json", "w") as f:\n`;
      prompt += `      json.dump(results, f, indent=2)\n`;
      prompt += `  \`\`\`\n`;
    } else {
      prompt += `  O JSON deve ter EXATAMENTE esta estrutura:\n`;
      prompt += `  {\n`;
      prompt += `    "model": "<classe_do_algoritmo_ex_XGBRegressor_ou_Ridge>",\n`;
      prompt += `    "best_params": { ..._parâmetros_de_hiperparametrização_... },\n`;
      prompt += `    "mae": <float_ou_null_mae>,\n`;
      prompt += `    "rmse": <float_ou_null_rmse>,\n`;
      prompt += `    "r2_score": <float_ou_null_r2_score>,\n`;
      prompt += `    "fold_scores": [<float>, ...],  // OBRIGATÓRIO: score de cada fold da CV. Sem isso o experimento é rejeitado [no_folds].\n`;
      prompt += `    "train_score": <float>,         // OBRIGATÓRIO: métrica no treino (gate de overfitting).\n`;
      prompt += `    "oof_path": "<string_ou_null>",\n`;
      prompt += `    "prod_path": "<string_ou_null>",\n`;
      prompt += `    "category": "<hyperparameter|feature_engineering|ensemble|model_selection|regularization|calibration>",\n`;
      prompt += `    "notes": "<string_ou_null>"  // cross-pollination: sugestão dirigida AO OUTRO time.\n`;
      prompt += `  }\n\n`;
      prompt += `  Exemplo de código para salvar o JSON no final do seu script:\n`;
      prompt += `  \`\`\`python\n`;
      prompt += `  import json, numpy as np\n`;
      prompt += `  # fold_scores = lista com o score de CADA fold (não a média!)\n`;
      prompt += `  results = {\n`;
      prompt += `      "model": type(model).__name__ if not hasattr(model, "steps") else type(model.steps[-1][1]).__name__,\n`;
      prompt += `      "best_params": model.get_params() if not hasattr(model, "steps") else model.steps[-1][1].get_params(),\n`;
      prompt += `      "mae": float(mae),\n`;
      prompt += `      "rmse": float(rmse),\n`;
      prompt += `      "r2_score": float(r2_score),\n`;
      prompt += `      "fold_scores": [float(s) for s in fold_scores],\n`;
      prompt += `      "train_score": float(train_score),\n`;
      prompt += `      "oof_path": "artifacts/models/${agent.id}_round${session.currentRound}_oof.npy",\n`;
      prompt += `      "prod_path": "artifacts/models/${agent.id}_round${session.currentRound}_prod.pkl",\n`;
      prompt += `      "category": "hyperparameter",\n`;
      prompt += `      "notes": "Sugestão para o outro time: ..."  # cross-pollination (opcional)\n`;
      prompt += `  }\n`;
      prompt += `  np.save("artifacts/models/${agent.id}_round${session.currentRound}_oof.npy", oof_preds)\n`;
      prompt += `  with open("artifacts/models/${agent.id}_round${session.currentRound}_results.json", "w") as f:\n`;
      prompt += `      json.dump(results, f, indent=2)\n`;
      prompt += `  \`\`\`\n`;
    }
    prompt += `- **RESPEITE os limites de complexidade acima.** Violá-los (ex: treinar FT-Transformer em dataset TINY) produzirá modelos com overfitting que serão descartados.\n`;
    if (process.env.FORMIGA_ARENA_LEGACY_OUTPUT === "1") {
      // ── Legacy output contract (rollback path) ──
      // Markers + script path. Only emitted when the operator opts back in
      // via FORMIGA_ARENA_LEGACY_OUTPUT=1; the JSON contract is the default.
      prompt += `- Finalize sua resposta com:\n`;
      prompt += `\n\`\`\`\n`;
      prompt += `HIPOTESE: <descrição de uma linha, em português>\n`;
      prompt += `SCRIPT_PATH: artifacts/models/${agent.id}_round${session.currentRound}.py\n`;
      prompt += `APRENDIZADO: <o que você aprendeu, em português>\n`;
      prompt += `PROXIMO_FOCO: <próxima ideia, em português>\n`;
      prompt += `STATUS: done\n`;
      prompt += `\`\`\`\n`;
    } else {
      // ── JSON envelope contract (default) ──
      prompt += `- Finalize sua resposta com UM ÚNICO bloco de código JSON (fence \`\`\`json) — SEM os marcadores legados HIPOTESE/SCRIPT_PATH/APRENDIZADO/PROXIMO_FOCO/STATUS. O script Python vai INLINE na chave "script" (cada quebra de linha do código vira um \\n dentro da string JSON), NUNCA como caminho de arquivo.\n`;
      prompt += `- O script DEVE: ler benchmark_config.json, treinar com CV na mesma configuração, imprimir EXATAMENTE ${config.metricName}: <valor_numerico> no stdout ANTES de encerrar, salvar o .pkl em artifacts/models/${agent.id}_round${session.currentRound}.pkl, e gravar o _results.json conforme a estrutura acima.\n`;
      prompt += `- **Disciplina de orçamento**: o script deve respeitar a variável de ambiente FORMIGA_MAX_FIT_SECONDS (limite por fit) e evitar combinações que estourem o tempo de execução — grids gigantes em datasets pequenos são descartados por overfitting.\n`;
      prompt += `- **Escreva o _results.json CEDO**: grave o JSON imediatamente APÓS computar fold_scores e train_score, e ANTES do retrain completo + inferência prod. Assim, mesmo se o script for morto por timeout no tail, o ledger já existe em disco.\n`;
      prompt += `- O JSON final deve ter EXATAMENTE esta forma:\n`;
      prompt += `\`\`\`json\n`;
      prompt += `{\n`;
      prompt += `  "script": "import pandas as pd\\nimport numpy as np\\n# ... código Python completo, com \\n em cada quebra de linha\\n",\n`;
      prompt += `  "hypothesis": "<hipótese de uma linha, em português>",\n`;
      prompt += `  "learned": "<o que você aprendeu, em português>",\n`;
      prompt += `  "nextFocus": "<próxima ideia, em português>"\n`;
      prompt += `}\n`;
      prompt += `\`\`\`\n`;
    }

    prompts[agent.id] = prompt;
  }

  return prompts;
}

function createCrashResult(agentId: string, reason: string, exitCode = 1): AgentRoundResult {
  return {
    agentId,
    hypothesis: "",
    learned: "",
    nextFocus: "",
    metric: null,
    decision: "crash",
    durationMs: 0,
    benchmarkStdout: "",
    benchmarkStderr: reason,
    benchmarkExitCode: exitCode,
    scriptPath: "",
  };
}

function emitArenaEvent(
  runId: string,
  round: number,
  results: AgentRoundResult[],
  session: ArenaSession,
): void {
  const keepCount = results.filter(r => r.decision === "keep" || r.decision === "baseline").length;
  const detail = `Round ${round} finished. Keep=${keepCount}, Best=${session.bestMetric ?? "N/A"}`;

  // Fire-and-forget via dynamic import (ESM compatible)
  void import("../installer/events.js").then((mod) => {
    if (typeof mod.emitEvent === "function") {
      mod.emitEvent({
        ts: new Date().toISOString(),
        event: "arena.round_complete",
        runId,
        agentId: session.bestAgent ?? undefined,
        detail,
      });
    }
  }).catch((err) => {
    // Graceful degradation: arena works even without event system
    console.error(`[arena-engine] failed to emit round_complete event:`, (err as Error).stack ?? String(err));
  });
}

interface RichMetricsResult {
  modelAlgorithm?: string | null;
  hyperparameters?: Record<string, unknown>;
  metricBag?: Record<string, number>;
  // ── Journal/ledger fields ──
  foldScores?: number[];
  trainScore?: number | null;
  oofArtifactKey?: string | null;
  prodArtifactKey?: string | null;
  brierRaw?: number | null;
  brierCalibrated?: number | null;
  eceCalibrated?: number | null;
  /** Distinct probability count in the OOF array (calibration-leak gate G4). */
  oofUniqueProbs?: number | null;
  notes?: string | null;
  category?: string | null;
  /** Optional per-feature importances (contract C1 — report top features). */
  featureImportances?: number[] | null;
}

/** Result of loading + validating an agent's `_results.json`. */
interface RichMetricsLoad {
  /** Extracted fields (empty on missing/corrupt file). */
  rich: RichMetricsResult;
  /** Structured failure reason (`[metrics_missing]`/`[metrics_invalid]`) or null when valid. */
  error: string | null;
}

/** Inputs for the shared failed-attempt ledger helper (contract A4). */
interface RegisterFailedArenaParams {
  agent: ArenaAgentConfig;
  round: number;
  config: ArenaConfig;
  datasetCtx: DatasetContext;
  result: AgentRoundResult;
  /** Benchmark execution result — undefined when the script never ran. */
  bench?: BenchmarkResult;
  /** Best-effort extras from a (possibly partial) _results.json. */
  rich?: RichMetricsResult;
  errorMessage: string | null;
  sessionContentHash: string | null;
}

/**
 * Validate a parsed `_results.json` against the strict arena contract.
 * Returns an error string prefixed with `[metrics_invalid]` when required
 * fields are missing; null when the payload satisfies the contract.
 *
 * Required by the contract:
 *   - fold_scores (or legacy `folds`): array of ≥2 finite numbers
 *   - train_score: finite number (overfit gate input)
 *   - classification: roc_auc, f1_score, precision, recall (finite numbers);
 *     log_loss must be present as a number or explicit null
 *   - regression: rmse, mae, r2_score (finite numbers)
 */
export function validateRichMetrics(
  json: Record<string, unknown>,
  problemType: string | null,
): string | null {
  const pt = normalizeProblemType(problemType);

  const num = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = json[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };

  const foldSrc = json.fold_scores ?? json.folds;
  const validFolds = (Array.isArray(foldSrc) ? foldSrc : []).filter((v) =>
    (typeof v === "number" && Number.isFinite(v)) ||
    (typeof v === "string" && Number.isFinite(Number(v))),
  );
  if (validFolds.length < 2) {
    return "[metrics_invalid] fold_scores deve ser um array com pelo menos 2 folds válidos";
  }

  if (num(["train_score", "train_mean", "cv_train_mean"]) === undefined) {
    return "[metrics_invalid] train_score é obrigatório (número finito)";
  }

  if (pt === "classification") {
    const required: Record<string, string[]> = {
      roc_auc: ["roc_auc", "auc", "cv_auc", "val_auc"],
      f1_score: ["f1_score", "f1", "cv_f1", "val_f1"],
      precision: ["precision", "cv_precision", "val_precision"],
      recall: ["recall", "cv_recall", "val_recall"],
    };
    for (const [key, aliases] of Object.entries(required)) {
      if (num(aliases) === undefined) {
        return `[metrics_invalid] classificação exige ${key} (número finito)`;
      }
    }
    // log_loss must be present — as a number or an explicit null.
    if (!("log_loss" in json) && !("cv_log_loss" in json) && !("val_log_loss" in json)) {
      return "[metrics_invalid] classificação exige log_loss (número ou null)";
    }
  } else if (pt === "regression") {
    const required: Record<string, string[]> = {
      rmse: ["rmse", "root_mean_squared_error", "cv_rmse", "val_rmse"],
      mae: ["mae", "mean_absolute_error", "cv_mae", "val_mae"],
      r2_score: ["r2_score", "r2", "cv_r2", "val_r2"],
    };
    for (const [key, aliases] of Object.entries(required)) {
      if (num(aliases) === undefined) {
        return `[metrics_invalid] regressão exige ${key} (número finito)`;
      }
    }
  }

  return null;
}

/**
 * Load an agent's `_results.json` and validate it against the contract.
 * Never throws — missing/corrupt files degrade to `{ rich: {}, error }` so
 * the caller can decide whether to fail-fast (only on a successful benchmark).
 */
export function tryLoadRichMetrics(
  workspacePath: string,
  agentId: string,
  round: number,
  problemType: string | null
): RichMetricsLoad {
  const resultsPath = path.join(workspacePath, SCRIPT_DIR, `${agentId}_round${round}_results.json`);
  if (!fs.existsSync(resultsPath)) {
    return {
      rich: {},
      error: `[metrics_missing] _results.json não encontrado em ${resultsPath}`,
    };
  }

  try {
    const raw = fs.readFileSync(resultsPath, "utf-8");
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      return {
        rich: {},
        error: `[metrics_invalid] _results.json corrompido: ${(err as Error).message}`,
      };
    }

    const modelAlgorithm = typeof json.model === "string" ? json.model :
                           typeof json.model_name === "string" ? json.model_name :
                           typeof json.algorithm === "string" ? json.algorithm : null;

    let hyperparameters: Record<string, unknown> | undefined;
    if (json.best_params && typeof json.best_params === "object") {
      hyperparameters = json.best_params as Record<string, unknown>;
    } else if (json.hyperparameters && typeof json.hyperparameters === "object") {
      hyperparameters = json.hyperparameters as Record<string, unknown>;
    }

    const metricBag: Record<string, number> = {};

    // Helper safely converting value to number
    const getNum = (val: unknown): number | undefined => {
      if (typeof val === "number" && !Number.isNaN(val)) return val;
      if (typeof val === "string") {
        const parsed = parseFloat(val);
        if (!Number.isNaN(parsed)) return parsed;
      }
      return undefined;
    };

    // Map metrics flexibly based on common keys
    const f1 = getNum(json.f1_score ?? json.f1 ?? json.cv_f1 ?? json.val_f1);
    if (f1 !== undefined) metricBag.f1_score = f1;

    const precision = getNum(json.precision ?? json.cv_precision ?? json.val_precision);
    if (precision !== undefined) metricBag.precision = precision;

    const recall = getNum(json.recall ?? json.cv_recall ?? json.val_recall);
    if (recall !== undefined) metricBag.recall = recall;

    const roc_auc = getNum(json.roc_auc ?? json.auc ?? json.cv_auc ?? json.val_auc);
    if (roc_auc !== undefined) metricBag.roc_auc = roc_auc;

    const log_loss = getNum(json.log_loss ?? json.cv_log_loss ?? json.val_log_loss);
    if (log_loss !== undefined) metricBag.log_loss = log_loss;

    const mae = getNum(json.mae ?? json.mean_absolute_error ?? json.cv_mae ?? json.val_mae);
    if (mae !== undefined) metricBag.mae = mae;

    const rmse = getNum(json.rmse ?? json.root_mean_squared_error ?? json.cv_rmse ?? json.val_rmse);
    if (rmse !== undefined) metricBag.rmse = rmse;

    const r2 = getNum(json.r2 ?? json.r2_score ?? json.cv_r2 ?? json.val_r2);
    if (r2 !== undefined) metricBag.r2_score = r2;

    // ── Journal/ledger fields ──
    // fold_scores: per-fold array, the input to Nadeau-Bengio significance.
    // Accept `fold_scores` or legacy `folds`. Each element must be a finite number.
    const foldSrc = json.fold_scores ?? json.folds;
    const foldScores = Array.isArray(foldSrc)
      ? foldSrc
          .map((v) => getNum(v))
          .filter((v): v is number => v !== undefined && Number.isFinite(v))
      : undefined;

    const trainScore = getNum(json.train_score ?? json.train_mean ?? json.cv_train_mean) ?? null;
    const oofArtifactKey = typeof json.oof_path === "string" ? json.oof_path : null;
    const prodArtifactKey = typeof json.prod_path === "string" ? json.prod_path : null;
    const brierRaw = getNum(json.brier_raw ?? json.brier_score_raw) ?? null;
    const brierCalibrated = getNum(json.brier_calibrated ?? json.brier_score_calibrated) ?? null;
    const eceCalibrated = getNum(json.ece_calibrated ?? json.ece) ?? null;
    // n_unique_probs: distinct values in the OOF probability array. The agent
    // computes this in Python (where it has the array) and reports it here;
    // the auditor uses it to detect saturation (gate G4). Accept int forms.
    const oofUniqueProbsRaw = json.n_unique_probs ?? json.unique_probs ?? json.oof_unique_probs;
    const oofUniqueProbs = getNum(oofUniqueProbsRaw) ?? null;
    const notes = typeof json.notes === "string" && json.notes.length > 0 ? json.notes : null;
    const category = typeof json.category === "string" && json.category.length > 0 ? json.category : null;

    // ── Optional top-feature importances (contract C1) ──
    const fiSrc = json.feature_importances ?? json.feature_importance;
    const featureImportances = Array.isArray(fiSrc)
      ? fiSrc
          .map((v) => getNum(v))
          .filter((v): v is number => v !== undefined && Number.isFinite(v))
      : null;

    const rich: RichMetricsResult = {
      modelAlgorithm,
      hyperparameters,
      metricBag,
      foldScores,
      trainScore,
      oofArtifactKey,
      prodArtifactKey,
      brierRaw,
      brierCalibrated,
      eceCalibrated,
      oofUniqueProbs,
      notes,
      category,
      featureImportances,
    };

    // Strict validation — the caller decides whether an error should fail-fast
    // (only when the benchmark itself "succeeded": exit 0 + parsed metric).
    const error = validateRichMetrics(json, problemType);
    return { rich, error };
  } catch (err) {
    // Unreadable file (permissions, IO error, …) — degrade with a reason.
    console.error(`[arena-engine] failed to read rich metrics from benchmark output:`, (err as Error).stack ?? String(err));
    return {
      rich: {},
      error: `[metrics_invalid] falha ao ler _results.json: ${(err as Error).message}`,
    };
  }
}

// ── Audit helpers ─────────────────────────────────────────────────────────

/** Map the dataset-context tier (lowercase) to the auditor's ComplexityTier. */
function mapTier(tier: DatasetContext["complexityTier"]): ComplexityTier {
  switch (tier) {
    case "tiny": return "TINY";
    case "small": return "SMALL";
    case "medium": return "MEDIUM";
    case "large": return "LARGE";
    default: return "UNKNOWN";
  }
}

/**
 * Read the session content_hash — MD5(features ‖ split ‖ config) — written by
 * the feature-engineer into benchmark_config.json. This is the intra-run
 * integrity anchor for gate G2. Returns null when absent (audit degrades
 * gracefully: no hash check, no stale rejection).
 */
function readSessionContentHash(workspacePath: string): string | null {
  const cfgPath = path.join(workspacePath, "benchmark_config.json");
  const altCfgPath = path.join(workspacePath, "artifacts", "benchmark_config.json");
  for (const candidate of [cfgPath, altCfgPath]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
      const hash = cfg.content_hash ?? cfg.contentHash;
      if (typeof hash === "string" && hash.length > 0) return hash;
    } catch {
      // ignore — try next path
    }
  }
  return null;
}

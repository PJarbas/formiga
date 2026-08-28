// ══════════════════════════════════════════════════════════════════════════════
// arena-workflow.ts — Bridge between the workflow scheduler and the arena engine.
//    When the workflow pipeline reaches the "arena" step, this module:
//      1. Reads runtime context (benchmark config, workspace path, run settings)
//      2. Builds an ArenaConfig
//      3. Invokes runArena() with a runAgentsParallel harness chosen from the
//         run's harness_type context (pi default, opencode/hermes opt-in)
//      4. On completion, calls completeStep() so the pipeline advances normally.
// ══════════════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";
import { getPrisma } from "../database/prisma.js";
import { logger } from "../lib/logger.js";
import { createHarnessRunner } from "../installer/scheduler/harness-runner.js";
import type { HarnessRunner } from "../installer/scheduler/harness-runner.js";
import type { HarnessType } from "../installer/types.js";
import { resolveFormigaAgentToolsExtension } from "../installer/paths.js";
import { completeStep } from "../installer/steps/complete.js";
import { emitEvent } from "../installer/events.js";
import type {
  ArenaConfig,
  ArenaAgentConfig,
  AgentRoundResult,
  BenchmarkResult,
} from "./arena-types.js";
import { runArena, type ArenaResult } from "./arena-engine.js";
import { ArenaRepositoryImpl } from "./arena-repository.js";
import { LeaderboardRepositoryImpl } from "../leaderboard/repository.js";
import { runBenchmark, extractMetric } from "./arena-benchmark.js";
import { normalizeProblemType, parseBenchmarkConfig } from "./benchmark-config.js";
import { deriveComputeBudget, type ComputeBudget } from "./dataset-context.js";
import { resolveAgentTimeout } from "./agent-timeout.js";

// ── Agent definitions (mirrors ml-autoresearch workflow.yml) ───────────────────

const ARENA_AGENTS: ArenaAgentConfig[] = [
  {
    id: "modeler-classic",
    agentPersona: "arena-modeler-classic",
    strategyHint:
      "You are a classic ML practitioner. Prefer gradient boosting, regularized linear models, " +
      "ensemble trees, and careful feature engineering. Avoid NN/AutoML — stay interpretable " +
      "and fast. Focus on strong cross-validation and hyperparameter discipline. " +
      "ALWAYS read the Dataset Context section above before choosing your approach — " +
      "on tiny datasets, prefer simpler models with heavy regularization.",
  },
  {
    id: "modeler-advanced",
    agentPersona: "arena-modeler-advanced",
    strategyHint:
      "You are an advanced ML researcher. Your approach MUST match the dataset complexity tier " +
      "shown in the Dataset Context section above. On TINY/SMALL datasets, prefer TabPFN, KAN, " +
      "or light AutoML — heavy NNs will overfit and get discarded by the benchmark. " +
      "On MEDIUM/LARGE datasets, use the full neural toolkit (FT-Transformer, deep stacking, etc.). " +
      "Read the EDA and Feature Engineering summaries to understand feature types and data quality. " +
      "Never ignore the MANDATORY Complexity Gates — they exist because the benchmark penalizes overfit.",
  },
  {
    id: "modeler-creative",
    agentPersona: "arena-modeler-creative",
    strategyHint:
      "You are the creative team. Your explicit goal is DIVERSITY: produce decorrelated models " +
      "that the other two teams would not, so the final ensemble dominates. Target Spearman OOF " +
      "correlation < 0.85 vs the current top-1. Explore: Denoising Autoencoders (swap noise 15-30%), " +
      "standalone entity embeddings, aggressive mRMR (~20 features forcing decorrelation), " +
      "target permutation (null importance), LightGBM monotonic constraints from the EDA, " +
      "Bayesian/Dirichlet blending, SHAP-interaction materialization. DO NOT repeat standard " +
      "approaches the other teams already cover. If an iteration does not produce a decorrelated " +
      "model, stop early. Only runs on MEDIUM/LARGE datasets.",
  },
];

// ── Benchmark config reader ─────────────────────────────────────────────

interface BenchmarkConfigJson {
  problemType?: string;
  metric?: {
    name: string;
    direction?: "lower" | "higher";
  };
  targetMetric?: number;
  maxRounds?: number;
  maxNoImprove?: number;
}

function normalizeDirection(dir: string | undefined): "lower" | "higher" | undefined {
  if (!dir) return undefined;
  if (dir === "minimize" || dir === "lower") return "lower";
  if (dir === "maximize" || dir === "higher") return "higher";
  return undefined;
}

// ── Infer metric direction from metric name ────────────────────────────────
// When benchmark_config.json doesn't specify direction and the run context
// doesn't provide one, infer it from the metric name.

const METRIC_DIRECTION_DEFAULTS: Record<string, "lower" | "higher"> = {
  // Lower is better (error/loss metrics)
  rmse: "lower",
  mse: "lower",
  mae: "lower",
  mape: "lower",
  rmsle: "lower",
  logloss: "lower",
  brier: "lower",
  hamming: "lower",
  // Higher is better (score/accuracy metrics)
  accuracy: "higher",
  auc: "higher",
  f1: "higher",
  r2: "higher",
  precision: "higher",
  recall: "higher",
  map: "higher",
  ndcg: "higher",
  roc_auc: "higher",
  average_precision: "higher",
};

function inferMetricDirection(metricName: string): "lower" | "higher" {
  const key = metricName.toLowerCase().replace(/[^a-z_]/g, "");
  return METRIC_DIRECTION_DEFAULTS[key] ?? "higher";
}

/**
 * Default primary metric when neither benchmark_config.json nor the run context
 * specifies one. Classification defaults to ROC-AUC (threshold-free, robust to
 * class imbalance), regression to RMSE — instead of the generic "cv_score" so
 * the leaderboard shows a metric that's meaningful for the problem.
 */
function inferDefaultMetric(problemType: string | null | undefined): string {
  const normalized = normalizeProblemType(problemType);
  if (normalized === "classification") return "roc_auc";
  if (normalized === "regression") return "rmse";
  return "cv_score";
}

function readBenchmarkConfig(workspace: string): BenchmarkConfigJson | null {
  // Look in workspace root first, then artifacts/
  const candidates = [
    path.join(workspace, "benchmark_config.json"),
    path.join(workspace, "artifacts", "benchmark_config.json"),
  ];
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    // Contract A5: structured parse — an invalid config is warned, never a
    // silent null. buildArenaConfig falls back to run-context defaults.
    const parsed = parseBenchmarkConfig(raw);
    if (!parsed.ok) {
      logger.warn(`[benchmark_config_invalid] ${parsed.error}`, { workspace });
      return {
        problemType: undefined,
        metric: undefined,
        targetMetric: undefined,
        maxRounds: undefined,
        maxNoImprove: undefined,
      };
    }
    const { problemType, metricName, metricDirection } = parsed.value;
    return {
      problemType: problemType ?? undefined,
      metric: metricName
        ? { name: metricName, direction: metricDirection ?? undefined }
        : undefined,
      targetMetric: raw.targetMetric,
      maxRounds: raw.maxRounds ?? raw.max_rounds,
      maxNoImprove: raw.maxNoImprove ?? raw.max_no_improve,
    };
  } catch {
    return null;
  }
}

// ── Prompt parsing helpers ─────────────────────────────────────────────

/**
 * Parse an arena agent's assistant text into the runnable contract.
 *
 * v2 — JSON-envelope FIRST, with the legacy marker/path format preserved as
 * a backward-compatible fallback (already-trained agents keep working).
 *
 * Precedence:
 *   1. Every ```` ```json ```` fence (and bare fences that parse as an object
 *      with a `script: string`), scanned LAST → FIRST; the first one that
 *      JSON.parse's and carries a non-empty `script` string wins.
 *   2. A bare JSON object containing `{"script":` (no fence).
 *   3. Legacy fallback (unchanged): HIPOTESE/HYPOTHESIS, SCRIPT_PATH + file
 *      read, APRENDIZADO/LEARNED, PROXIMO_FOCO/NEXT_FOCUS, ```` ```python ````.
 *
 * Missing JSON keys fall back to `""`. The JSON envelope is the new contract:
 * `script` is inline Python code (never a path).
 */
/**
 * Cap the free-text insight fields so a runaway agent that dumps source code /
 * file contents into its response can't pollute the leaderboard's
 * hypothesis/learned columns (observed: a modeler pasted ~43KB of
 * arena-engine.ts into `hypothesis`). Legit insights are a sentence or two.
 */
const MAX_INSIGHT_CHARS = 2000;

function capInsight(text: string): string {
  return text.length > MAX_INSIGHT_CHARS ? text.slice(0, MAX_INSIGHT_CHARS) : text;
}

export function parseArenaAgentOutput(
  stdout: string,
  workspacePath: string,
): {
  script: string;
  hypothesis: string;
  learned: string;
  nextFocus: string;
} {
  // 1. JSON fences, scanned last → first.
  const fences = [...stdout.matchAll(/```(?:json)?\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = parseJsonEnvelope(fences[i]);
    if (parsed) return parsed;
  }

  // 2. Bare JSON object (no fence) — slice from the opening brace.
  const bareJson = stdout.match(/\{\s*"script"\s*:/);
  if (bareJson && bareJson.index !== undefined) {
    const parsed = parseJsonEnvelope(stdout.slice(bareJson.index));
    if (parsed) return parsed;
  }

  // 3. Legacy fallback: markers + script path + python block.
  const hypothesisMatch = stdout.match(/(?:HYPOTHESIS|HIPOTESE):\s*(.+?)(?:\n|$)/i);
  const scriptPathMatch = stdout.match(/SCRIPT_PATH:\s*(.+?)(?:\n|$)/i);
  const learnedMatch = stdout.match(/(?:LEARNED|APRENDIZADO):\s*(.+?)(?:\n|$)/i);
  const nextFocusMatch = stdout.match(/(?:NEXT_FOCUS|PROXIMO_FOCO):\s*(.+?)(?:\n|$)/i);

  // Try to read the script from the file the agent claimed to have written
  let script = "";
  if (scriptPathMatch) {
    const relPath = scriptPathMatch[1].trim();
    const absPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(workspacePath, relPath);
    if (fs.existsSync(absPath)) {
      try {
        script = fs.readFileSync(absPath, "utf-8");
      } catch { /* best effort */ }
    }
  }

  // Fallback: extract Python code block from the output
  if (!script) {
    const block = stdout.match(/```(?:python)?\n([\s\S]*?)\n```/);
    if (block) script = block[1];
  }

  return {
    script,
    hypothesis: capInsight(hypothesisMatch ? hypothesisMatch[1].trim() : ""),
    learned: capInsight(learnedMatch ? learnedMatch[1].trim() : ""),
    nextFocus: capInsight(nextFocusMatch ? nextFocusMatch[1].trim() : ""),
  };
}

/**
 * Attempt to parse a JSON response envelope. Returns the extracted contract
 * when the text parses as an object with a non-empty `script` string; else
 * null (caller falls through to the next precedence tier).
 */
function parseJsonEnvelope(
  raw: string,
): { script: string; hypothesis: string; learned: string; nextFocus: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.script !== "string") return null;
  return {
    script: o.script,
    hypothesis: capInsight(typeof o.hypothesis === "string" ? o.hypothesis : ""),
    learned: capInsight(typeof o.learned === "string" ? o.learned : ""),
    nextFocus: capInsight(typeof o.nextFocus === "string" ? o.nextFocus : ""),
  };
}

// ── Agent generation timeout ──────────────────────────────────────────────
// Resolved dynamically from the complexity tier + compute budget by
// resolveAgentTimeout (agent-timeout.ts): an absolute hard cap scaled to the
// dataset, plus a stale threshold re-armed on agent output. A fixed 30-min
// wall-clock killed actively-training modelers on LARGE datasets (run
// e5cccd51) — a working agent must never be killed by a wall clock, only a
// stuck one (silent for staleMs) or a runaway one (past the hard cap).

interface ArenaAgentOutput {
  script: string;
  hypothesis: string;
  learned?: string;
  nextFocus?: string;
  /** Runner failure message (LLM timeout / process crash). Present ⇒ no response. */
  error?: string;
  /** Wall-clock the agent actually ran before failing (0 on success). */
  durationMs?: number;
}

interface SettledAgentResult {
  agentId: string;
  ok: boolean;
  data: ArenaAgentOutput | null;
  error?: string;
  durationMs?: number;
}

// ── runAgentsParallel factory (backed by HarnessRunner) ──────────────────

/**
 * Create a runAgentsParallel function that delegates to a HarnessRunner
 * for each arena agent prompt. Timeouts are dynamic (see agent-timeout.ts):
 * derived from the dataset_context.json snapshot persisted by
 * readDatasetContext (tier + compute budget).
 */
function createRunAgentsParallel(runner: HarnessRunner) {
  return async function runAgentsParallel(
    prompts: Record<string, string>,
    config: ArenaConfig,
  ): Promise<Record<string, ArenaAgentOutput | null>> {
    // Derive tier + budget for timeout selection from the persisted snapshot
    // (single source of truth, written by readDatasetContext). Falls back to
    // MEDIUM / no budget when the snapshot is missing.
    let tier = "MEDIUM";
    let computeBudget: ComputeBudget | null = null;
    try {
      const dsPath = path.join(config.workspacePath, "artifacts", "dataset_context.json");
      if (fs.existsSync(dsPath)) {
        const ds = JSON.parse(fs.readFileSync(dsPath, "utf-8")) as {
          complexityTier?: string;
          computeBudget?: ComputeBudget;
        };
        if (ds.complexityTier) tier = ds.complexityTier;
        computeBudget = ds.computeBudget ?? null;
      }
    } catch { /* keep defaults */ }

    const budget = computeBudget ?? deriveComputeBudget(tier as Parameters<typeof deriveComputeBudget>[0]);
    const { hardTimeoutMs, staleTimeoutMs } = resolveAgentTimeout(tier, budget);

    const entries = Object.entries(prompts);
    const pending = entries.map(([agentId, prompt]) => {
      const startedAt = Date.now();
      return runner
        .run(prompt, {
          timeout: Math.ceil(hardTimeoutMs / 1000),
          hardTimeoutMs,
          staleTimeoutMs,
          workdir: config.workspacePath,
        })
        .then((result) => {
          // Emit progress event
          emitEvent({
            ts: new Date().toISOString(),
            event: "arena.agent_script_done",
            runId: config.runId,
            agentId,
            detail: `Script generated in ${result.durationMs}ms`,
          });
          return parseArenaAgentOutput(result.assistantText, config.workspacePath);
        })
        .then((parsed): SettledAgentResult => ({
          agentId,
          ok: true,
          data: {
            script: parsed.script,
            hypothesis: parsed.hypothesis,
            learned: parsed.learned || undefined,
            nextFocus: parsed.nextFocus || undefined,
          },
        }))
        .catch((err): SettledAgentResult => {
          const durationMs = Date.now() - startedAt;
          logger.error("Arena agent runner failure", { agentId, error: String(err), durationMs });
          return {
            agentId,
            ok: false,
            data: null,
            error: String(err),
            durationMs,
          };
        });
    });

    const settled = await Promise.all(pending);
    const out: Record<string, ArenaAgentOutput | null> = {};
    for (const s of settled) {
      // Keep `null` for contract-broken output (backward compatible with the
      // engine's guards) — but surface the failure error/duration on a
      // non-null object so the engine can record real duration_ms.
      out[s.agentId] = s.ok ? s.data : { script: "", hypothesis: "", error: s.error, durationMs: s.durationMs };
    }
    return out;
  };
}

// ── Harness resolution ─────────────────────────────────────────

/**
 * Read the harness_type from the run's context JSON, mirroring the scheduler
 * path (cron-manager.ts). Defaults to "pi" when absent or unreadable.
 */
async function resolveRunHarnessType(runId: string): Promise<HarnessType> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { context: true },
    });
    if (run?.context) {
      const ctx = JSON.parse(run.context) as Record<string, unknown>;
      if (ctx.harness_type === "hermes") return "hermes";
      if (ctx.harness_type === "opencode") return "opencode";
    }
  } catch (err) {
    logger.warn("Arena resolveRunHarnessType: failed to read run context, using pi", {
      runId,
      error: String(err),
    });
  }
  return "pi";
}

// ── Config builder ─────────────────────────────────────────────

async function buildArenaConfig(runId: string): Promise<ArenaConfig | null> {
  const prisma = getPrisma();
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { context: true, workflow_id: true },
  });
  if (!run?.context) {
    logger.error("Arena buildArenaConfig: run has no context", { runId });
    return null;
  }

  let ctx: Record<string, string>;
  try {
    ctx = JSON.parse(run.context) as Record<string, string>;
  } catch (err) {
    logger.error("Arena buildArenaConfig: failed to parse run context", { runId, error: String(err) });
    return null;
  }

  const workspace = ctx.workspace ?? ctx.working_directory_for_harness ?? process.cwd();
  const benchmarkConfig = readBenchmarkConfig(workspace);
  if (!benchmarkConfig) {
    logger.warn("Arena buildArenaConfig: no benchmark_config.json found, using defaults", { runId, workspace });
  }

  const metricName =
    benchmarkConfig?.metric?.name ??
    ctx.metric_name ??
    inferDefaultMetric(benchmarkConfig?.problemType);
  const metricDirection: "lower" | "higher" =
    benchmarkConfig?.metric?.direction ??
    (ctx.metric_direction as "lower" | "higher") ??
    inferMetricDirection(metricName);
  const targetMetric =
    benchmarkConfig?.targetMetric ??
    (ctx.target_metric ? Number(ctx.target_metric) : undefined);
  const maxRounds =
    benchmarkConfig?.maxRounds ??
    (ctx.max_rounds ? Number(ctx.max_rounds) : undefined) ??
    5;
  const maxNoImprove =
    benchmarkConfig?.maxNoImprove ??
    (ctx.max_no_improve ? Number(ctx.max_no_improve) : undefined) ??
    3;

  // Look for benchmark script (optional — arena uses direct execution by default)
  const candidatePaths = [
    path.join(workspace, "autoresearch.sh"),
    path.join(workspace, "artifacts", "autoresearch.sh"),
    path.join(workspace, "artifacts", "benchmark_runner.py"),
  ];
  const benchmarkScript = candidatePaths.find((p) => fs.existsSync(p));

  return {
    runId,
    workflowId: run.workflow_id ?? undefined,
    workspacePath: workspace,
    benchmarkScript,
    metricName,
    metricDirection,
    targetMetric,
    maxRounds,
    maxNoImprove,
    commitOnKeep: false,
    revertOnDiscard: false,
    agents: ARENA_AGENTS,
    formigaApi: ctx.formiga_api ?? process.env.FORMIGA_DASHBOARD_URL ?? "http://localhost:3334",
  };
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Arena runs currently active in this process (run_id). Guards against
 * duplicate in-process launches of the same run: direct-spawn (fresh launch)
 * and the reconciler (re-admission after a daemon restart) both funnel through
 * launchArenaFromStep. Empty on boot, so a restart can always re-admit.
 */
const activeArenaRuns = new Set<string>();

/**
 * Launch the arena engine for a workflow run's arena step.
 *
 * This is invoked by spawnAgentsForPendingSteps (direct-spawn.ts) when it
 * detects a pending "arena" step, and by the reconciler to re-admit a
 * resumable session after a daemon restart (AL-4). The function:
 *   1. Leaves the step in "running"
 *   2. Builds the ArenaConfig from run context + benchmark_config.json
 *   3. Calls runArena() with the pi-based parallel harness
 *   4. On completion, calls completeStep(stepId, output) so the pipeline advances.
 *
 * It is designed to be fire-and-forget from the scheduler; any errors are
 * logged and surfaced by marking the step failed. The activeArenaRuns guard
 * makes concurrent launches of the same run a no-op.
 */
export async function launchArenaFromStep(
  runId: string,
  stepId: string,
): Promise<void> {
  if (activeArenaRuns.has(runId)) {
    logger.warn(
      `arena workflow: run ${runId.slice(0, 8)} already active in-process — skipping duplicate launch`,
    );
    return;
  }
  activeArenaRuns.add(runId);
  try {
    await launchArenaFromStepInner(runId, stepId);
  } finally {
    activeArenaRuns.delete(runId);
  }
}

async function launchArenaFromStepInner(
  runId: string,
  stepId: string,
): Promise<void> {
  const prisma = getPrisma();

  // Mark step as running so it isn't picked up by any other scheduler tick
  const now = new Date();
  await prisma.step.update({
    where: { id: stepId },
    data: { status: "running", updated_at: now },
  });

  emitEvent({
    ts: now.toISOString(),
    event: "step.running",
    runId,
    stepId,
    agentId: "arena-engine",
    detail: "Arena competition engine started",
  });

  const config = await buildArenaConfig(runId);
  if (!config) {
    const err = "Arena engine failed to build config (missing benchmark_config.json or run context)";
    logger.error(err, { runId, stepId });
    await markStepFailed(stepId, runId, err);
    return;
  }

  try {
    const repo = new ArenaRepositoryImpl();
    const leaderboardRepo = new LeaderboardRepositoryImpl();

    // Resolve harness from run context (default "pi"). Only pi uses the
    // formiga-agent-tools extension; opencode/hermes run without it.
    const harnessType = await resolveRunHarnessType(runId);
    const extensionPath =
      harnessType === "pi" ? resolveFormigaAgentToolsExtension() : null;
    const runner = createHarnessRunner(harnessType, {
      ...(extensionPath ? { harnessSpecific: { extensionPath } } : {}),
    });

    const result = await runArena(
      config,
      repo,
      leaderboardRepo,
      createRunAgentsParallel(runner),
    );

    const output = formatArenaResultOutput(result);

    // completeStep will advance the pipeline internally.
    await completeStep(stepId, output);

    emitEvent({
      ts: new Date().toISOString(),
      event: "arena.completed",
      runId,
      stepId,
      detail: `Rounds=${result.totalRounds} BestMetric=${result.bestMetric ?? "N/A"} BestAgent=${result.bestAgent ?? "N/A"} Reason=${result.stopReason}`,
    });

    logger.info("Arena workflow segment completed", {
      runId,
      stepId,
      totalRounds: result.totalRounds,
      bestMetric: result.bestMetric,
      bestAgent: result.bestAgent,
      stopReason: result.stopReason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error("Arena engine threw during run", { runId, stepId, error: msg, stack });
    // Call completeStep with error output so the retry mechanism works.
    // The expects validation will fail (no "STATUS: done" match), and the
    // step will be reset to pending with retry_count incremented.
    const errorOutput = `STATUS: error\nERROR: ${msg}\nSTACK: ${stack ?? "N/A"}`;
    await completeStep(stepId, errorOutput);
  }
}

// ── Internal helpers ─────────────────────────────────────────────

function formatArenaResultOutput(result: ArenaResult): string {
  return [
    "STATUS: done",
    `TOTAL_ROUNDS: ${result.totalRounds}`,
    `BEST_METRIC: ${result.bestMetric ?? "N/A"}`,
    `BEST_AGENT: ${result.bestAgent ?? "N/A"}`,
    `STOP_REASON: ${result.stopReason}`,
    `TOTAL_KEEP: ${result.totalKeep}`,
    `TOTAL_DISCARD: ${result.totalDiscard}`,
    `TOTAL_CRASH: ${result.totalCrash}`,
    `CHANGES: Arena competition completed after ${result.totalRounds} rounds.`,
    `TESTS: Benchmark-driven cross-validation.`,
  ].join("\n");
}

async function markStepFailed(
  stepId: string,
  runId: string,
  error: string,
): Promise<void> {
  const prisma = getPrisma();
  const now = new Date();
  await prisma.step.update({
    where: { id: stepId },
    data: { status: "failed", output: error, updated_at: now },
  });
  await prisma.run.update({
    where: { id: runId },
    data: { status: "failed", updated_at: now },
  });
}

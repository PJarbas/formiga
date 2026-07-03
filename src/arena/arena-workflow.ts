// ══════════════════════════════════════════════════════════════════════════════
// arena-workflow.ts — Bridge between the workflow scheduler and the arena engine.
//    When the workflow pipeline reaches the "arena" step, this module:
//      1. Reads runtime context (benchmark config, workspace path, run settings)
//      2. Builds an ArenaConfig
//      3. Invokes runArena() with a Pi-based runAgentsParallel harness
//      4. On completion, calls completeStep() so the pipeline advances normally.
// ══════════════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";
import { getPrisma } from "../database/prisma.js";
import { logger } from "../lib/logger.js";
import { runPi } from "../installer/scheduler/pi-runner.js";
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

const AGENT_TIMEOUT_SECONDS = parseInt(
  process.env.FORMIGA_ARENA_AGENT_TIMEOUT ?? "1800",
  10,
);

// ── Agent definitions (mirrors ml-autoresearch workflow.yml) ───────────────────

const ARENA_AGENTS: ArenaAgentConfig[] = [
  {
    id: "modeler-classic",
    agentPersona: "arena-modeler-classic",
    timeout: AGENT_TIMEOUT_SECONDS,
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
    timeout: AGENT_TIMEOUT_SECONDS,
    strategyHint:
      "You are an advanced ML researcher. Your approach MUST match the dataset complexity tier " +
      "shown in the Dataset Context section above. On TINY/SMALL datasets, prefer TabPFN, KAN, " +
      "or light AutoML — heavy NNs will overfit and get discarded by the benchmark. " +
      "On MEDIUM/LARGE datasets, use the full neural toolkit (FT-Transformer, deep stacking, etc.). " +
      "Read the EDA and Feature Engineering summaries to understand feature types and data quality. " +
      "Never ignore the MANDATORY Complexity Gates — they exist because the benchmark penalizes overfit.",
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
    // Normalize: metric can be a string ("rmse") or object ({ name, direction })
    let metric: BenchmarkConfigJson["metric"] | undefined;
    if (typeof raw.metric === "string") {
      metric = { name: raw.metric, direction: normalizeDirection(raw.direction ?? raw.metric_direction) };
    } else if (raw.metric && typeof raw.metric === "object") {
      metric = { name: raw.metric.name, direction: normalizeDirection(raw.metric.direction) };
    }
    return {
      problemType: raw.type ?? raw.problemType,
      metric,
      targetMetric: raw.targetMetric,
      maxRounds: raw.maxRounds ?? raw.max_rounds,
      maxNoImprove: raw.maxNoImprove ?? raw.max_no_improve,
    };
  } catch {
    return null;
  }
}

// ── Prompt parsing helpers ─────────────────────────────────────────────

function parseArenaAgentOutput(
  stdout: string,
  workspacePath: string,
): {
  script: string;
  hypothesis: string;
  learned: string;
  nextFocus: string;
} {
  // Extract metadata markers
  const hypothesisMatch = stdout.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
  const scriptPathMatch = stdout.match(/SCRIPT_PATH:\s*(.+?)(?:\n|$)/i);
  const learnedMatch = stdout.match(/LEARNED:\s*(.+?)(?:\n|$)/i);
  const nextFocusMatch = stdout.match(/NEXT_FOCUS:\s*(.+?)(?:\n|$)/i);

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
    hypothesis: hypothesisMatch ? hypothesisMatch[1].trim() : "",
    learned: learnedMatch ? learnedMatch[1].trim() : "",
    nextFocus: nextFocusMatch ? nextFocusMatch[1].trim() : "",
  };
}

// ── runAgentsParallel harness (backed by pi --print) ───────────────────

async function piRunAgentsParallel(
  prompts: Record<string, string>,
  config: ArenaConfig,
): Promise<
  Record<
    string,
    { script: string; hypothesis: string; learned?: string; nextFocus?: string } | null
  >
> {
  const entries = Object.entries(prompts);
  const pending = entries.map(([agentId, prompt]) => {
    const agentDef = ARENA_AGENTS.find((a) => a.id === agentId);
    const timeout = agentDef?.timeout ?? AGENT_TIMEOUT_SECONDS;

    return runPi(
      ["--print", "--mode", "json", "--no-session", prompt],
      {
        timeout,
        workdir: config.workspacePath,
      },
    )
      .then((stdout) => parseArenaAgentOutput(stdout, config.workspacePath))
      .then((parsed) => ({
        agentId,
        ok: true as const,
        data: {
          script: parsed.script,
          hypothesis: parsed.hypothesis,
          learned: parsed.learned || undefined,
          nextFocus: parsed.nextFocus || undefined,
        },
      }))
      .catch((err) => {
        logger.error("Arena agent pi failure", { agentId, error: String(err) });
        return {
          agentId,
          ok: false as const,
          data: null,
        };
      });
  });

  const settled = await Promise.all(pending);
  const out: Record<
    string,
    { script: string; hypothesis: string; learned?: string; nextFocus?: string } | null
  > = {};
  for (const s of settled) {
    out[s.agentId] = s.ok ? s.data : null;
  }
  return out;
}

// ── Config builder ─────────────────────────────────────────────

async function buildArenaConfig(runId: string): Promise<ArenaConfig | null> {
  const prisma = getPrisma();
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { context: true },
  });
  if (!run?.context) return null;

  let ctx: Record<string, string>;
  try {
    ctx = JSON.parse(run.context) as Record<string, string>;
  } catch {
    return null;
  }

  const workspace = ctx.workspace ?? ctx.working_directory_for_harness ?? process.cwd();
  const benchmarkConfig = readBenchmarkConfig(workspace);

  const metricName =
    benchmarkConfig?.metric?.name ?? ctx.metric_name ?? "cv_score";
  const metricDirection: "lower" | "higher" =
    benchmarkConfig?.metric?.direction ??
    (ctx.metric_direction as "lower" | "higher") ??
    "higher";
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
  };
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Launch the arena engine for a workflow run's arena step.
 *
 * This is invoked by spawnAgentsForPendingSteps (direct-spawn.ts) when it
 * detects a pending "arena" step. The function:
 *   1. Leaves the step in "running"
 *   2. Builds the ArenaConfig from run context + benchmark_config.json
 *   3. Calls runArena() with the pi-based parallel harness
 *   4. On completion, calls completeStep(stepId, output) so the pipeline advances.
 *
 * It is designed to be fire-and-forget from the scheduler; any errors are
 * logged and surfaced by marking the step failed.
 */
export async function launchArenaFromStep(
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

    const result = await runArena(
      config,
      repo,
      leaderboardRepo,
      piRunAgentsParallel,
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
    logger.error("Arena engine threw during run", { runId, stepId, error: msg });
    await markStepFailed(stepId, runId, `Arena engine error: ${msg}`);
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

// ════════════════════════════════════════════════════════════════════════
// arena-engine.ts — Main competition loop: fan-out agents, benchmark measure,
//                    register results, detect convergence.
// Pure orchestration logic; dependencies injected (repo, benchmark runner).
// ════════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { ArenaConfig, ArenaSession, ArenaStatus, AgentRoundResult, BenchmarkResult } from "./arena-types.js";
import type { ArenaRepository } from "./arena-repository.js";
import type { ArenaExperiment } from "../leaderboard/repository.js";
import { makeDecision, isImprovement } from "./arena-decision.js";
import { extractMetric } from "./arena-benchmark.js";

const SCRIPT_DIR = "artifacts/models";
const BENCHMARK_TIMEOUT_MS = 120_000;
const TRAIN_TIMEOUT_MS = 180_000;

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
async function trainScript(
  scriptPath: string,
  workspacePath: string,
): Promise<{ modelPath: string | null; stdout: string; stderr: string; exitCode: number | null }> {
  const expectedPkl = scriptPath.replace(/\.py$/, ".pkl");
  return new Promise((resolve) => {
    const child = spawn(`python3 "${scriptPath}"`, {
      cwd: workspacePath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORMIGA_WORKSPACE: workspacePath },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, TRAIN_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = killed ? null : code;
      // Look for generated .pkl at the expected path
      const modelPath = fs.existsSync(expectedPkl) ? expectedPkl : null;
      resolve({ modelPath, stdout, stderr, exitCode });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ modelPath: null, stdout, stderr: stderr + err.message, exitCode: null });
    });
  });
}

/**
 * Run a single benchmark and return the parsed result.
 */
async function benchmarkOne(
  config: ArenaConfig,
  scriptPath: string,
): Promise<BenchmarkResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const command = `bash ${config.benchmarkScript} "${scriptPath}"`;
    const child = spawn(command, {
      cwd: config.workspacePath,
      shell: true,
      stdio: [ "ignore", "pipe", "pipe" ],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, BENCHMARK_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

    child.on("close", (code) => {
      clearTimeout(timer);
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

/**
 * Run the full arena loop.
 */
export async function runArena(
  config: ArenaConfig,
  repo: ArenaRepository,
  leaderboardRepo: { registerArena(entry: ArenaExperiment): Promise<number> },
  // We inject a function that runs agents in parallel and returns their outputs.
  runAgentsParallel: (
    prompts: Record<string, string>,
    config: ArenaConfig,
  ) => Promise<Record<string, { script: string; hypothesis: string; learned?: string; nextFocus?: string } | null>>
): Promise<ArenaResult> {
  ensureScriptDir(config.workspacePath);

  // 1. Create session
  const session: ArenaSession = await repo.createFromConfig(config.runId, config);

  // 2. Establish baseline from benchmark_config.json or by running benchmark script
  let baselineMetric: number | null = null;
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
  // Fallback: run benchmark with baseline .pkl if no config baseline
  if (baselineMetric === null) {
    const baselinePkl = path.join(config.workspacePath, "artifacts", "baseline.pkl");
    if (fs.existsSync(baselinePkl)) {
      const baseline = await benchmarkOne(config, baselinePkl);
      baselineMetric = baseline.metric;
    }
  }
  if (baselineMetric !== null) {
    await repo.setBaseline(session.id, baselineMetric);
    session.baselineMetric = baselineMetric;
    session.bestMetric = baselineMetric;
  }

  let consecutiveNoImprove = 0;
  let stopReason = "max_rounds";

  // History tracking for prompts
  const allResults: AgentRoundResult[] = [];

  // 3. Round loop
  for (let round = 1; round <= config.maxRounds; round++) {
    session.currentRound = round;

    // Build prompts
    const prompts = buildPromptsForRound(config, session, allResults);

    // Fan-out: run all agents in parallel
    const agentOutputs = await runAgentsParallel(prompts, config);

    // Measure sequentially (resource contention)
    const roundResults: AgentRoundResult[] = [];
    for (const agent of config.agents) {
      const output = agentOutputs[agent.id];
      if (!output) {
        roundResults.push(createCrashResult(agent.id, "Agent returned no output"));
        continue;
      }

      const scriptPath = path.join(config.workspacePath, SCRIPT_DIR, `${agent.id}_round${round}.py`);
      fs.writeFileSync(scriptPath, output.script, "utf-8");

      // Execute the agent's script directly — it trains, evaluates, and prints metric
      const exec = await trainScript(scriptPath, config.workspacePath);
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
        hypothesis: output.hypothesis,
        learned: output.learned ?? "",
        nextFocus: output.nextFocus ?? "",
        metric: bench.metric,
        decision,
        durationMs: bench.durationMs,
        benchmarkStdout: bench.stdout,
        benchmarkStderr: bench.stderr,
        benchmarkExitCode: bench.exitCode,
        scriptPath: scriptPath.replace(config.workspacePath + path.sep, ""),
      };

      roundResults.push(result);

      // Register experiment in leaderboard
      const experimentId = await leaderboardRepo.registerArena({
        run_id: config.runId,
        round_number: round,
        agent_name: agent.id,
        model_type: "arena_script",
        hypothesis: output.hypothesis,
        learned: output.learned,
        next_focus: output.nextFocus,
        measured_metric: bench.metric,
        benchmark_stdout: bench.stdout,
        benchmark_stderr: bench.stderr,
        benchmark_exit_code: bench.exitCode,
        decision,
        duration_ms: bench.durationMs,
        artifact_script: result.scriptPath,
        metric_name: config.metricName,
        artifact_path: result.scriptPath,
      });
      result.experimentId = experimentId;

      // Update session state
      const improved = result.decision === "keep" || result.decision === "baseline";
      if (improved && result.metric !== null) {
        session.bestMetric = result.metric;
        session.bestAgent = agent.id;
        session.bestExperimentId = result.experimentId ?? null;
        consecutiveNoImprove = 0;
      } else {
        consecutiveNoImprove++;
      }
      session.consecutiveNoImprove = consecutiveNoImprove;

      // Update repo stats
      await repo.updateStats(session.id, result.decision);
    }

    // Persist round result
    allResults.push(...roundResults);
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

  for (const agent of config.agents) {
    const myHistory = allResults.filter(r => r.agentId === agent.id);
    const othersKept = allResults.filter(r => r.agentId !== agent.id && (r.decision === "keep" || r.decision === "baseline"));

    // Minimal prompt construction inline to avoid circular import
    let prompt = `## Competition Arena — Round ${session.currentRound}\n\n`;
    prompt += `You are ${agent.id}. Beat the current best.\n\n`;
    prompt += `### Current Best\n`;
    prompt += `Metric: ${session.bestMetric ?? "N/A"} (${config.metricDirection} is better)\n`;
    prompt += `Target: ${config.targetMetric ?? "none"}\n\n`;
    prompt += `### Your History\n`;
    if (myHistory.length === 0) prompt += "(none yet)\n";
    else {
      for (const h of myHistory) {
        prompt += `  Round ${session.currentRound - 1}: ${h.hypothesis} → ${h.metric !== null ? h.metric.toFixed(6) : "crash"} (${h.decision})\n`;
      }
    }
    prompt += `\n### Others' Kept Results\n`;
    if (othersKept.length === 0) prompt += "(none yet)\n";
    else {
      for (const o of othersKept) {
        prompt += `  ${o.agentId}: "${o.hypothesis}" → ${o.metric !== null ? o.metric.toFixed(6) : "crash"}\n`;
      }
    }
    prompt += `\n### Strategy\n${agent.strategyHint}\n\n`;
    prompt += `### Rules\n`;
    prompt += `- Write a STANDALONE Python script that trains a model and evaluates it.\n`;
    prompt += `- The script must read benchmark_config.json from the workspace root.\n`;
    prompt += `- Use cross-validation with the same config (same splits, same metric).\n`;
    prompt += `- At the end, print EXACTLY this line to stdout: ${config.metricName}: <numeric_value>\n`;
    prompt += `- Example output: ${config.metricName}: 4500.1234\n`;
    prompt += `- Also save your trained model as: artifacts/models/${agent.id}_round${session.currentRound}.pkl\n`;
    prompt += `- Save script to: artifacts/models/${agent.id}_round${session.currentRound}.py\n`;
    prompt += `- End your response with:\n`;
    prompt += `\n\`\`\`\n`;
    prompt += `HYPOTHESIS: <one-line description>\n`;
    prompt += `SCRIPT_PATH: artifacts/models/${agent.id}_round${session.currentRound}.py\n`;
    prompt += `LEARNED: <what you learned>\n`;
    prompt += `NEXT_FOCUS: <next idea>\n`;
    prompt += `STATUS: done\n`;
    prompt += `\`\`\`\n`;

    prompts[agent.id] = prompt;
  }

  return prompts;
}

function createCrashResult(agentId: string, reason: string): AgentRoundResult {
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
    benchmarkExitCode: 1,
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
  }).catch(() => {
    // Graceful degradation: arena works even without event system
  });
}

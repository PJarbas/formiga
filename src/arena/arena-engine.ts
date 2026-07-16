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
import { readDatasetContext, formatDatasetContextForPrompt, type DatasetContext } from "./dataset-context.js";

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
    const child = spawn("python3", [scriptPath], {
      cwd: workspacePath,
      shell: false,
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
  leaderboardRepo: { registerArena(entry: ArenaExperiment): Promise<number>; getBestByDatasetSignature(signature: string, limit?: number): Promise<Array<{ model_type: string; hyperparameters: Record<string, unknown>; val_metric: number }>> },
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

  // Read dataset context once for the entire arena run
  const datasetCtx = readDatasetContext(config.workspacePath);

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

  // 3. Round loop
  for (let round = 1; round <= config.maxRounds; round++) {
    session.currentRound = round;

    // Build prompts with dataset context for complexity-aware generation
    const prompts = buildPromptsForRound(config, session, allResults, datasetCtx, warmStartHints);

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

      const richMetrics = tryLoadRichMetrics(config.workspacePath, agent.id, round, datasetCtx.problemType);

      // Register experiment in leaderboard
      const experimentId = await leaderboardRepo.registerArena({
        run_id: config.runId,
        round_number: round,
        agent_name: agent.id,
        model_type: agent.modelType ?? agent.id,
        model_algorithm: richMetrics.modelAlgorithm ?? agent.modelType ?? agent.id,
        hyperparameters: richMetrics.hyperparameters ?? {},
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
        metric_bag: richMetrics.metricBag,
        problem_type: datasetCtx.problemType,
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
  datasetCtx: DatasetContext,
  warmStartHints: string[] = [],
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
    prompt += `\n### Estratégia\n${agent.strategyHint}\n\n`;
    if (warmStartHints.length > 0 && session.currentRound === 1) {
      prompt += `### Warm-Start: Melhores Anteriores para Este Dataset\n`;
      prompt += warmStartHints.join("\n") + "\n\n";
    }
    // Inject Formiga API helpers for artifact access
    const apiUrl = config.formigaApi ?? process.env.FORMIGA_DASHBOARD_URL ?? "http://localhost:3334";
    prompt += `### Formiga API (acesso a artefatos)\n\n`;
    prompt += `Use estas funções bash para ler/salvar artefatos e consultar o leaderboard:\n\n`;
    prompt += `\`\`\`bash\n`;
    prompt += `formiga_read_artifact() {\n`;
    prompt += `  curl -s "${apiUrl}/api/runs/${config.runId}/agent-artifacts/$1" | jq -r '.content'\n`;
    prompt += `}\n\n`;
    prompt += `formiga_save_artifact() {\n`;
    prompt += `  local key="$1"; local content="$2"\n`;
    prompt += `  curl -s -X POST "${apiUrl}/api/runs/${config.runId}/agent-artifacts/$key" \\\n`;
    prompt += `    -H "Content-Type: application/json" \\\n`;
    prompt += `    -d "{\\"stepId\\": \\"arena\\", \\"agentId\\": \\"${agent.id}\\", \\"content\\": $content}"\n`;
    prompt += `}\n\n`;
    prompt += `formiga_leaderboard() {\n`;
    prompt += `  curl -s "${apiUrl}/api/leaderboard/$1?runId=${config.runId}"\n`;
    prompt += `}\n`;
    prompt += `\`\`\`\n\n`;
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
    if (datasetCtx.problemType === "classification") {
      prompt += `  O JSON deve ter EXATAMENTE esta estrutura:\n`;
      prompt += `  {\n`;
      prompt += `    "model": "<classe_do_algoritmo_ex_XGBClassifier_ou_SVC>",\n`;
      prompt += `    "best_params": { ..._parâmetros_de_hiperparametrização_... },\n`;
      prompt += `    "f1_score": <float_ou_null_f1_macro_ou_f1>,\n`;
      prompt += `    "precision": <float_ou_null_precision_macro>,\n`;
      prompt += `    "recall": <float_ou_null_recall_macro>,\n`;
      prompt += `    "roc_auc": <float_ou_null_roc_auc_ou_roc_auc_ovr>,\n`;
      prompt += `    "log_loss": <float_ou_null_neg_log_loss_invertido_sinal>\n`;
      prompt += `  }\n\n`;
      prompt += `  Exemplo de código para salvar o JSON no final do seu script:\n`;
      prompt += `  \`\`\`python\n`;
      prompt += `  import json\n`;
      prompt += `  # Calcule as métricas ricas usando cross_val_score ou cross_validate com a mesma estratégia de splits (CV)\n`;
      prompt += `  # Ex: f1 = cross_val_score(model, X, y, cv=cv, scoring="f1_macro").mean()\n`;
      prompt += `  results = {\n`;
      prompt += `      "model": type(model).__name__ if not hasattr(model, "steps") else type(model.steps[-1][1]).__name__,\n`;
      prompt += `      "best_params": model.get_params() if not hasattr(model, "steps") else model.steps[-1][1].get_params(),\n`;
      prompt += `      "f1_score": float(f1_score),\n`;
      prompt += `      "precision": float(precision),\n`;
      prompt += `      "recall": float(recall),\n`;
      prompt += `      "roc_auc": float(roc_auc),\n`;
      prompt += `      "log_loss": float(log_loss)  # use o valor positivo do log_loss\n`;
      prompt += `  }\n`;
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
      prompt += `    "r2_score": <float_ou_null_r2_score>\n`;
      prompt += `  }\n\n`;
      prompt += `  Exemplo de código para salvar o JSON no final do seu script:\n`;
      prompt += `  \`\`\`python\n`;
      prompt += `  import json\n`;
      prompt += `  # Calcule as métricas ricas usando cross_val_score ou cross_validate com a mesma estratégia de splits (CV)\n`;
      prompt += `  # Ex: r2 = cross_val_score(model, X, y, cv=cv, scoring="r2").mean()\n`;
      prompt += `  results = {\n`;
      prompt += `      "model": type(model).__name__ if not hasattr(model, "steps") else type(model.steps[-1][1]).__name__,\n`;
      prompt += `      "best_params": model.get_params() if not hasattr(model, "steps") else model.steps[-1][1].get_params(),\n`;
      prompt += `      "mae": float(mae),\n`;
      prompt += `      "rmse": float(rmse),\n`;
      prompt += `      "r2_score": float(r2_score)\n`;
      prompt += `  }\n`;
      prompt += `  with open("artifacts/models/${agent.id}_round${session.currentRound}_results.json", "w") as f:\n`;
      prompt += `      json.dump(results, f, indent=2)\n`;
      prompt += `  \`\`\`\n`;
    }
    prompt += `- **RESPEITE os limites de complexidade acima.** Violá-los (ex: treinar FT-Transformer em dataset TINY) produzirá modelos com overfitting que serão descartados.\n`;
    prompt += `- Finalize sua resposta com:\n`;
    prompt += `\n\`\`\`\n`;
    prompt += `HIPOTESE: <descrição de uma linha, em português>\n`;
    prompt += `SCRIPT_PATH: artifacts/models/${agent.id}_round${session.currentRound}.py\n`;
    prompt += `APRENDIZADO: <o que você aprendeu, em português>\n`;
    prompt += `PROXIMO_FOCO: <próxima ideia, em português>\n`;
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

interface RichMetricsResult {
  modelAlgorithm?: string | null;
  hyperparameters?: Record<string, unknown>;
  metricBag?: Record<string, number>;
}

function tryLoadRichMetrics(
  workspacePath: string,
  agentId: string,
  round: number,
  problemType: string | null
): RichMetricsResult {
  const resultsPath = path.join(workspacePath, SCRIPT_DIR, `${agentId}_round${round}_results.json`);
  if (!fs.existsSync(resultsPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(resultsPath, "utf-8");
    const json = JSON.parse(raw) as Record<string, unknown>;

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

    return { modelAlgorithm, hyperparameters, metricBag };
  } catch (err) {
    // Silently degrade if file is corrupt or unreadable
    return {};
  }
}

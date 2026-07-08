// ══════════════════════════════════════════════════════════════════════
// pi-executor.ts — FanOutExecutor that invokes agents via pi harness
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import type { AgentRunner, AgentContext, AgentResult } from "../agents/interfaces.js";
import { runPi } from "../installer/scheduler/pi-runner.js";
import type { FanOutExecutor } from "./fan-out.js";

const AGENT_TIMEOUT_SECONDS = parseInt(process.env.FORMIGA_PI_EXECUTOR_TIMEOUT ?? "1800", 10); // 30 min default

/**
 * Default FanOutExecutor that runs agents through the pi harness.
 *
 * 1. Builds the prompt via agent.buildPrompt(context).
 * 2. Invokes `pi --print` via runPi.
 * 3. Parses stdout looking for:
 *    - "STATUS: done"  → SUCCESS
 *    - "STATUS: fail"  → FAILED
 * 4. For modeler agents, attempts to read the sidecar JSON from the
 *    workspace to populate structured AgentResult fields.
 *
 * This bridges the programmatic RoundManager path with the actual
 * pi harness used by the workflow YAML scheduler path.
 */
export const piFanOutExecutor: FanOutExecutor = async (
  agent: AgentRunner,
  context: AgentContext,
): Promise<AgentResult> => {
  const prompt = agent.buildPrompt(context);

  // Invoke pi harness with disk streaming to survive large outputs
  const outputFile = path.join(
    context.workspacePath,
    ".pi-output",
    `pi-output-${agent.name}-${Date.now()}.log`,
  );

  const result = await runPi(
    ["--print", "--mode", "json", "--no-session", prompt],
    {
      timeout: AGENT_TIMEOUT_SECONDS,
      workdir: context.workspacePath,
      outputFile,
    },
  );

  // Use streaming-extracted STATUS marker (already parsed during streaming)
  const statusMarker = result.metadata.statusMarker ?? "unknown";
  const isSuccess = statusMarker === "done" || statusMarker === "success";

  // Try to read sidecar JSON for structured results (modelers)
  // Canonical path: {workspace}/artifacts/{agent}_submission.json
  let sidecar: Record<string, unknown> | undefined;
  const sidecarPath = path.join(
    context.workspacePath,
    "artifacts",
    `${agent.name}_submission.json`,
  );
  if (fs.existsSync(sidecarPath)) {
    try {
      const raw = fs.readFileSync(sidecarPath, "utf-8");
      sidecar = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignore malformed sidecar
    }
  }

  return buildAgentResult(agent.name, isSuccess, result.assistantText, sidecar);
};

function buildAgentResult(
  agentName: string,
  isSuccess: boolean,
  stdout: string,
  sidecar?: Record<string, unknown>,
): AgentResult {
  if (!isSuccess) {
    return {
      agentName,
      status: "FAILED",
      errorMessage: extractFailureReason(stdout),
    };
  }

  const result: AgentResult = {
    agentName,
    status: "SUCCESS",
    modelType: sidecar?.model_type as string | undefined,
    hyperparameters: sidecar?.hyperparameters as Record<string, unknown> | undefined,
    cvMean: parseNumeric(sidecar?.cv_mean),
    cvStd: parseNumeric(sidecar?.cv_std),
    trainMean: parseNumeric(sidecar?.train_mean),
    artifactPath: sidecar?.artifact_path as string | undefined,
    trainTimeSeconds: parseNumeric(sidecar?.train_time_seconds),
    metricName: sidecar?.metric_name as string | undefined,
    outputs: { summary: stdout.slice(-2048) },
  };

  return result;
}

function extractFailureReason(stdout: string): string {
  const patterns = [
    /ERROR:\s*(.+?)(?:\n|$)/i,
    /Exception:\s*(.+?)(?:\n|$)/i,
    /Traceback[\s\S]{0,200}/,
    /STATUS:\s*fail(?:ed)?\s*[-—]\s*(.+?)(?:\n|$)/i,
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) return m[1]?.trim() ?? m[0].slice(0, 200);
  }
  // Fallback: last non-empty line
  const lastLine = stdout.trim().split("\n").at(-1)?.trim();
  return lastLine || "Agent failed without explicit reason";
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

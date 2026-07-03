// ══════════════════════════════════════════════════════════════════════
// arena-benchmark.ts — Run benchmark script and parse metrics.
// Stateless: only child_process + regex extraction.
// ══════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import type { BenchmarkResult } from "./arena-types.js";

const DEFAULT_BENCHMARK_TIMEOUT_MS = 120_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the primary metric value from benchmark stdout.
 * Tries exact match first, then generic fallbacks.
 */
export function extractMetric(output: string, metricName: string): number | null {
  const patterns = [
    // Exact match: "rmse: 10392.11" or "rmse = 10392.11"
    new RegExp(`${escapeRegExp(metricName)}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    // benchmark_runner.py format: "PRIMARY (rmse): 10392.1144 ± ..."
    new RegExp(`PRIMARY\\s*\\(${escapeRegExp(metricName)}\\)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    // cv_ prefixed: "cv_rmse_mean: 10392.11"
    new RegExp(`cv_${escapeRegExp(metricName)}(?:_mean)?\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
    // JSON "primary_value": 10392.11
    /"primary_value"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    // Generic fallbacks
    /(?:metric|score|loss|result)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i,
  ];

  for (const regex of patterns) {
    const match = output.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Run the benchmark shell script against a model script.
 *
 * @param benchmarkScript — path to `autoresearch.sh` (or equivalent)
 * @param modelScript       — path to the agent-generated Python file
 * @param cwd               — working directory for execution
 * @param timeoutMs         — max time to wait
 */
export function runBenchmark(
  benchmarkScript: string,
  modelScript: string,
  cwd: string,
  timeoutMs = DEFAULT_BENCHMARK_TIMEOUT_MS,
): Promise<BenchmarkResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const command = `bash ${benchmarkScript} "${modelScript}"`;

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      resolve({
        exitCode: killed ? null : code,
        stdout,
        stderr,
        durationMs,
        metric: null, // metric extracted separately by caller
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + err.message,
        durationMs: Date.now() - started,
        metric: null,
      });
    });
  });
}

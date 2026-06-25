// ══════════════════════════════════════════════════════════════════════
// hermes-runner.ts — Low-level hermes binary invocation
// ══════════════════════════════════════════════════════════════════════
//
// `runHermes` spawns hermes as a detached process group child with the
// prompt provided via `-q`. Unlike pi, hermes emits plain text (not
// streamed JSON events), so stdout is collected in full and a session_id
// trailer is stripped before returning.
// ══════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { logger } from "../../lib/logger.js";
import { findHermesBinary } from "./binary-discovery.js";
import { buildStreamLogMetadata, safeKillPgid } from "./shared.js";
import type { RunPiOptions } from "./pi-runner.js";

export async function runHermes(
  prompt: string,
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const hermesPath = await findHermesBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const startedAt = Date.now();

  // Hermes single-shot invocation:
  // -q <prompt> delivers the task in single message mode.
  // --max-turns 8192 gives the agent plenty of room to complete the work.
  // --yolo skips permission confirmations (hermes equivalent of pi -y).
  // -Q suppresses banner/spinner (but NOT session_id).
  // Keep user config enabled so Hermes uses the configured provider/model.
  const args = [
    "chat",
    "--max-turns", "8192",
    "--yolo",
    "-Q",
    "-q", prompt,
  ];

  logger.info("hermes pre-launch", {
    harness: "hermes",
    hermesPath,
    promptLength: Buffer.byteLength(prompt, "utf-8"),
    timeoutMs,
    workdir: options.workdir,
  });

  // Spawn hermes in its own process group for clean termination.
  const child = spawn(hermesPath, args, {
    cwd: options.workdir ?? process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const childPid = child.pid;
  const pgid = childPid ?? 0;

  if (childPid && options.onSpawn) {
    try {
      options.onSpawn({ pid: childPid, pgid });
    } catch (err) {
      logger.warn("hermes onSpawn callback threw", { error: String(err) });
    }
  }

  logger.info("hermes launched", {
    harness: "hermes",
    pid: childPid ?? null,
    pgid,
    timeoutMs,
    workdir: options.workdir,
  });

  // End stdin immediately — hermes reads from args (-q).
  child.stdin?.end();

  // Collect stderr (bounded).
  let stderrPieces: string[] = [];
  let stderrBytes = 0;
  const MAX_STDERR_BYTES = 10 * 1024 * 1024;
  child.stderr?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
      stderrPieces.push(str);
      stderrBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  // Collect stdout fully (hermes produces plain text, not JSON events).
  let stdoutPieces: string[] = [];
  let stdoutBytes = 0;
  const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
  child.stdout?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stdoutBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDOUT_BYTES) {
      stdoutPieces.push(str);
      stdoutBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  // Wait for child exit, with timeout guard.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (pgid) {
        safeKillPgid(pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      reject(new Error(`hermes timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0 || code === null) {
        resolve();
      } else {
        const failureDurationMs = Date.now() - startedAt;
        const failureStderr = stderrPieces.join("");
        const failureStderrMeta = buildStreamLogMetadata(failureStderr);
        logger.error("hermes execution failed", {
          harness: "hermes",
          pid: childPid ?? null,
          pgid,
          exitCode: code,
          signal,
          durationMs: failureDurationMs,
          stderrBytes: failureStderrMeta.bytes,
          stderrPreview: failureStderrMeta.preview,
          stderrTruncated: failureStderrMeta.truncated,
        });
        const stderrSuffix = failureStderr ? `\nstderr: ${failureStderr}` : "";
        reject(new Error(`hermes failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
      }
    });
  });

  const durationMs = Date.now() - startedAt;
  const rawStdout = stdoutPieces.join("");
  const stderrOut = stderrPieces.join("");
  const stderrMeta = buildStreamLogMetadata(stderrOut);

  if (stderrMeta.preview) {
    logger.warn("hermes stderr", {
      harness: "hermes",
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  // Filter out session_id lines. Hermes appends a session identifier
  // (e.g. "session_id: 20260518_103004_cdae11") at the end of stdout.
  // Remove it so the scheduler sees clean output.
  const filteredStdout = rawStdout
    .split("\n")
    .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
    .join("\n")
    .trim();

  const stdoutMeta = buildStreamLogMetadata(filteredStdout);

  logger.info("hermes completed", {
    harness: "hermes",
    pid: childPid ?? null,
    pgid,
    durationMs,
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdoutBytes: stdoutMeta.bytes,
    stdoutPreview: stdoutMeta.preview,
    stdoutTruncated: stdoutMeta.truncated,
    stderrBytes: stderrMeta.bytes,
    hasStderr: stderrMeta.bytes > 0,
  });

  return filteredStdout;
}

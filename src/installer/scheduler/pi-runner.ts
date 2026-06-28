// ══════════════════════════════════════════════════════════════════════
// pi-runner.ts — Low-level pi binary invocation
// ══════════════════════════════════════════════════════════════════════
//
// `runPi` spawns pi --print as a detached process group child, applies a
// timeout, captures stdout (parsed via parsePiOutputStream) and stderr,
// then returns the filtered stdout. The optional `onSpawn` callback lets
// the scheduler register the pi pid + pgid into `inFlightChildren` so
// termination paths can SIGTERM/SIGKILL the whole process tree.
// ══════════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../../lib/logger.js";
import { findPiBinary, formatPiCommandPreview, parsePiOutputStream } from "./binary-discovery.js";
import { buildStreamLogMetadata, safeKillPgid } from "./shared.js";

export interface RunPiOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
  /**
   * Optional callback invoked once the child process is spawned. Used by
   * `executePollingRound` to register the child + pgid in `inFlightChildren`
   * so termination paths can kill the process group.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
}

export async function runPi(
  args: string[],
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const piPath = await findPiBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const preview = formatPiCommandPreview(piPath, args);
  const startedAt = Date.now();

  logger.info("pi pre-launch", {
    commandPreview: preview.commandPreview,
    argvPreview: preview.argvPreview,
    redactedIndices: preview.redactedIndices,
    truncatedIndices: preview.truncatedIndices,
    promptElided: preview.promptElided,
    argCount: preview.argCount,
    timeoutMs,
    workdir: options.workdir,
  });

  // Spawn pi in its own process group so termination paths can kill the
  // whole subtree (pi spawns its own child processes for tools/sessions).
  const child = spawn(piPath, args, {
    cwd: options.workdir ?? process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const childPid = child.pid;
  // On Linux, the spawned child becomes its own group leader (pgid === pid)
  // when detached:true. Fall back to childPid if getpgid is unavailable.
  const pgid = childPid ?? 0;

  if (childPid && options.onSpawn) {
    try {
      options.onSpawn({ pid: childPid, pgid });
    } catch (err) {
      logger.warn("pi onSpawn callback threw", { error: String(err) });
    }
  }

  logger.info("pi launched", {
    pid: childPid ?? null,
    pgid,
    timeoutMs,
    workdir: options.workdir,
  });

  // End stdin immediately — pi --print waits for stdin EOF before responding
  child.stdin?.end();

  // Collect stderr (bounded)
  let stderrPieces: string[] = [];
  let stderrBytes = 0;
  const MAX_STDERR_BYTES = 10 * 1024 * 1024; // 10MB cap for stderr
  child.stderr?.on("data", (chunk: Buffer) => {
    const str = chunk.toString("utf-8");
    if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
      stderrPieces.push(str);
      stderrBytes += Buffer.byteLength(str, "utf-8");
    }
  });

  // Stream stdout through readline → parsePiOutputStream.
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const parseResultPromise = parsePiOutputStream(rl);

  // Wait for child exit. Apply timeout guard.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Terminate the whole process group: SIGTERM, then SIGKILL after 5s.
      if (pgid) {
        safeKillPgid(pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
      } else {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      reject(new Error(`pi timed out after ${timeoutMs}ms`));
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
        logger.error("pi execution failed", {
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
        reject(new Error(`pi failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
      }
    });
  });

  // Wait for stdout parsing to finish (it will complete once stdout closes)
  const parseResult = await parseResultPromise;

  const durationMs = Date.now() - startedAt;
  const stderrOut = stderrPieces.join("");
  const stderrMeta = buildStreamLogMetadata(stderrOut);

  if (stderrMeta.preview) {
    logger.warn("pi stderr", {
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  // Reconstruct filtered stdout from parsed events for backwards compatibility.
  const filteredLines: string[] = [];
  if (parseResult.textFallback !== null) {
    filteredLines.push(parseResult.textFallback);
  }
  for (const event of parseResult.events) {
    filteredLines.push(JSON.stringify(event));
  }
  if (parseResult.assistantText.length > 0) {
    filteredLines.push(parseResult.assistantText);
  }
  const filteredStdout = filteredLines.join("\n");
  const stdoutMeta = buildStreamLogMetadata(filteredStdout);

  logger.info("pi completed", {
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
    outputTruncatedByBuffer: parseResult.truncated,
    totalBytesIngested: parseResult.totalBytesIngested,
    linesDropped: parseResult.linesDropped,
  });

  if (parseResult.truncated) {
    logger.warn("pi output exceeded ring buffer capacity — only tail retained", {
      pid: childPid ?? null,
      totalBytesIngested: parseResult.totalBytesIngested,
      linesDropped: parseResult.linesDropped,
      retainedBytes: stdoutMeta.bytes,
    });
  }

  return filteredStdout.trim();
}

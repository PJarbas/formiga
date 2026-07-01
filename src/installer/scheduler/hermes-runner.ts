// ══════════════════════════════════════════════════════════════════════
// hermes-runner.ts — Low-level hermes binary invocation
// ══════════════════════════════════════════════════════════════════════
//
// `runHermes` spawns hermes as a detached process group child with the
// prompt provided via `-q`. Unlike pi, hermes emits plain text (not
// streamed JSON events), so stdout is collected in full and a session_id
// trailer is stripped before returning.
//
// When `outputFile` is provided, stdout is streamed to disk with a bounded
// memory buffer, preventing OOM on very large outputs.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { logger } from "../../lib/logger.js";
import { findHermesBinary } from "./binary-discovery.js";
import { buildStreamLogMetadata, safeKillPgid } from "./shared.js";
import type { RunPiOptions } from "./pi-runner.js";

/** Internal helper: stream stdout to a file while keeping a bounded tail in memory. */
async function streamHermesStdout(
  stdout: NodeJS.ReadableStream,
  outputFile: string,
  maxMemoryBytes = 64 * 1024,
): Promise<{ memoryTail: string; totalBytes: number; lines: number }> {
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const writeStream = fs.createWriteStream(outputFile);

  let totalBytes = 0;
  let lines = 0;
  const memoryBuffer: string[] = [];
  let memoryBytes = 0;

  for await (const chunk of stdout) {
    const str = (chunk as Buffer).toString("utf-8");
    const chunkBytes = Buffer.byteLength(str, "utf-8");
    totalBytes += chunkBytes;

    if (!writeStream.write(str)) {
      await new Promise<void>((resolve) => writeStream.once("drain", resolve));
    }

    const chunkLines = str.split(/\r?\n/);
    for (const line of chunkLines) {
      memoryBuffer.push(line);
      lines++;
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      memoryBytes += lineBytes;

      while (memoryBytes > maxMemoryBytes && memoryBuffer.length > 1) {
        const dropped = memoryBuffer.shift()!;
        memoryBytes -= Buffer.byteLength(dropped, "utf-8") + 1;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
    writeStream.end();
  });

  return { memoryTail: memoryBuffer.join("\n"), totalBytes, lines };
}

/** Internal helper: read the tail of a file. */
async function readTail(filePath: string, maxBytes = 512 * 1024): Promise<string> {
  try {
    const stats = await fs.promises.stat(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const stream = fs.createReadStream(filePath, { start, encoding: "utf-8" });
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk as string);
    return chunks.join("");
  } catch {
    return "";
  }
}

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
    outputFile: options.outputFile ?? null,
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
    outputFile: options.outputFile ?? null,
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

  // ── stdout handling: stream to disk if outputFile provided ────────────────
  let rawStdout = "";
  let totalStdoutBytes = 0;
  let usedDiskStreaming = false;

  if (options.outputFile) {
    const maxMemoryKb = parseInt(process.env.FORMIGA_PI_OUTPUT_MAX_MEMORY_KB ?? "64", 10);
    const maxMemoryBytes = Math.max(4 * 1024, maxMemoryKb * 1024);
    const result = await streamHermesStdout(child.stdout!, options.outputFile, maxMemoryBytes);
    totalStdoutBytes = result.totalBytes;
    rawStdout = result.memoryTail;
    usedDiskStreaming = true;
  } else {
    // Legacy: collect stdout fully in memory (10MB cap)
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

    // Wait for data collection and child exit simultaneously
    await new Promise<void>((resolve) => {
      child.stdout?.on("end", resolve);
      child.stdout?.on("close", resolve);
    });
    rawStdout = stdoutPieces.join("");
    totalStdoutBytes = stdoutBytes;
  }

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

  // Determine filtered stdout
  let filteredStdout = "";
  if (usedDiskStreaming && options.outputFile) {
    const maxReadBytes = 512 * 1024;
    const tail = await readTail(options.outputFile, maxReadBytes);
    // Filter out session_id lines from tail
    filteredStdout = tail
      .split("\n")
      .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
      .join("\n")
      .trim();
  } else {
    // Filter out session_id lines. Hermes appends a session identifier
    // (e.g. "session_id: 20260518_103004_cdae11") at the end of stdout.
    // Remove it so the scheduler sees clean output.
    filteredStdout = rawStdout
      .split("\n")
      .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
      .join("\n")
      .trim();
  }

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
    usedDiskStreaming,
    totalStdoutBytes,
  });

  return filteredStdout;
}

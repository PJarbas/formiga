// ══════════════════════════════════════════════════════════════════════
// pi-runner.ts — Low-level pi binary invocation
// ══════════════════════════════════════════════════════════════════════
//
// `runPi` spawns pi --print as a detached process group child, applies a
// timeout, captures stdout (parsed via parsePiOutputStream) and stderr,
// then returns the filtered stdout. The optional `onSpawn` callback lets
// the scheduler register the pi pid + pgid into `inFlightChildren` so
// termination paths can SIGTERM/SIGKILL the whole process tree.
//
// When `outputFile` is provided, stdout is streamed to disk instead of
// kept entirely in memory. Only the trailing bytes required for metadata
// extraction are retained in memory. This prevents OOM crashes when pi
// produces very large outputs (e.g. 256 MB).
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
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
  /**
   * Optional path to stream stdout into. When provided, pi output is written
   * to disk in real time. Only a bounded tail is kept in memory for
   * metadata extraction. Prevents OOM on very large outputs.
   */
  outputFile?: string;
}

/** Utility: drain stdout into a file while also buffering the tail. */
async function streamStdoutWithBuffer(
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

    // Write to disk immediately (streaming)
    if (!writeStream.write(str)) {
      // Back-pressure: wait for drain
      await new Promise<void>((resolve) => writeStream.once("drain", resolve));
    }

    // Buffer tail in memory for metadata extraction
    const chunkLines = str.split(/\r?\n/);
    for (const line of chunkLines) {
      memoryBuffer.push(line);
      lines++;
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
      memoryBytes += lineBytes;

      while (memoryBytes > maxMemoryBytes && memoryBuffer.length > 1) {
        const dropped = memoryBuffer.shift()!;
        memoryBytes -= Buffer.byteLength(dropped, "utf-8") + 1;
      }
    }
  }

  // Close write stream
  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
    writeStream.end();
  });

  return { memoryTail: memoryBuffer.join("\n"), totalBytes, lines };
}

/** Utility: read the last N bytes from a file. */
async function readTailFromFile(filePath: string, maxBytes = 512 * 1024): Promise<string> {
  try {
    const stats = await fs.promises.stat(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const stream = fs.createReadStream(filePath, { start, encoding: "utf-8" });
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as string);
    }
    return chunks.join("");
  } catch {
    return "";
  }
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
    outputFile: options.outputFile ?? null,
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
    outputFile: options.outputFile ?? null,
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

  // ── stdout handling: disk streaming or in-memory ─────────────────
  let parseResult: Awaited<ReturnType<typeof parsePiOutputStream>>;
  let totalStdoutBytes = 0;
  let usedDiskStreaming = false;

  if (options.outputFile) {
    // Disk streaming mode: write to file + keep bounded tail in memory
    const maxMemoryKb = parseInt(process.env.FORMIGA_PI_OUTPUT_MAX_MEMORY_KB ?? "64", 10);
    const maxMemoryBytes = Math.max(4 * 1024, maxMemoryKb * 1024); // min 4KB

    const { memoryTail, totalBytes, lines } = await streamStdoutWithBuffer(
      child.stdout!,
      options.outputFile,
      maxMemoryBytes,
    );
    totalStdoutBytes = totalBytes;
    usedDiskStreaming = true;

    // Parse metadata from the memory tail
    const { parsePiOutputFromString } = await import("./binary-discovery.js");
    parseResult = parsePiOutputFromString(memoryTail, totalBytes, lines);
  } else {
    // Legacy in-memory mode: readline + ring buffer
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    parseResult = await parsePiOutputStream(rl);
    totalStdoutBytes = parseResult.totalBytesIngested;
  }

  // Wait for child exit. Apply timeout guard.
  // (stdout was already consumed above, so child should close soon)
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

  // Build result string: if disk streaming, read tail from file; otherwise use buffer content
  let resultString = "";
  if (usedDiskStreaming && options.outputFile) {
    const maxReadBytes = 512 * 1024; // Read up to last 512KB from file for result
    resultString = await readTailFromFile(options.outputFile, maxReadBytes);
  } else {
    // Legacy path: reconstruct from parseResult
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
    resultString = filteredLines.join("\n");
  }

  const stdoutMeta = buildStreamLogMetadata(resultString);

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
    usedDiskStreaming,
  });

  if (parseResult.truncated) {
    logger.warn("pi output exceeded buffer capacity — only tail retained", {
      pid: childPid ?? null,
      totalBytesIngested: parseResult.totalBytesIngested,
      linesDropped: parseResult.linesDropped,
      retainedBytes: stdoutMeta.bytes,
      usedDiskStreaming,
    });
  }

  return resultString.trim();
}

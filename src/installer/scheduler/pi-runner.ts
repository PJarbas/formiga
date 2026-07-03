// ══════════════════════════════════════════════════════════════════════
// pi-runner.ts — Low-level pi binary invocation
// ══════════════════════════════════════════════════════════════════════
//
// `runPi` spawns pi --print as a detached process group child, applies a
// timeout, streams stdout to disk while extracting metadata in real-time
// via StreamingMetadataExtractor, then returns the extracted metadata.
//
// Always uses disk streaming — no in-memory ring buffer path.
// Memory guarantee: O(maxAssistantBytes) regardless of pi output size.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { logger } from "../../lib/logger.js";
import { findPiBinary, formatPiCommandPreview } from "./binary-discovery.js";
import { buildStreamLogMetadata, safeKillPgid } from "./shared.js";
import { StreamingMetadataExtractor, type ExtractedMetadata } from "./streaming-metadata-extractor.js";

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
   * If not provided, a temp file is created automatically.
   */
  outputFile?: string;
}

/** Result of runPi — structured metadata instead of raw string. */
export interface RunPiResult {
  /** Extracted metadata (STATUS, tokens, IDs, assistant text). */
  metadata: ExtractedMetadata;
  /** The assistant text tail (convenience accessor, same as metadata.assistantTextTail). */
  assistantText: string;
  /** Path to the output file on disk (may be deleted if FORMIGA_KEEP_PI_OUTPUT not set). */
  outputFile: string;
  /** Duration of pi invocation in ms. */
  durationMs: number;
  /** Pi process exit code. */
  exitCode: number | null;
  /** Pi process signal, if killed. */
  signalCode: string | null;
}

/** Utility: drain stdout into a file while feeding lines to the streaming extractor. */
async function streamStdoutWithExtractor(
  stdout: NodeJS.ReadableStream,
  outputFile: string,
  extractor: StreamingMetadataExtractor,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const writeStream = fs.createWriteStream(outputFile);

  for await (const chunk of stdout) {
    const str = (chunk as Buffer).toString("utf-8");

    // Write to disk immediately (streaming)
    if (!writeStream.write(str)) {
      // Back-pressure: wait for drain
      await new Promise<void>((resolve) => writeStream.once("drain", resolve));
    }

    // Feed each line to the streaming metadata extractor
    const lines = str.split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) {
        extractor.processLine(line);
      }
    }
  }

  // Close write stream
  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
    writeStream.end();
  });
}

/** Default temp output file path. */
function makeDefaultOutputFile(): string {
  const dir = path.join(os.homedir(), ".formiga", ".pi-output");
  return path.join(dir, `pi-output-${process.pid}-${Date.now()}.log`);
}

export async function runPi(
  args: string[],
  options: RunPiOptions = {},
): Promise<RunPiResult> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const piPath = await findPiBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
  };

  const preview = formatPiCommandPreview(piPath, args);
  const startedAt = Date.now();
  const outputFile = options.outputFile ?? makeDefaultOutputFile();

  // Streaming extractor: bounded memory, real-time metadata extraction
  const maxAssistantKb = parseInt(process.env.FORMIGA_PI_OUTPUT_MAX_MEMORY_KB ?? "256", 10);
  const maxAssistantBytes = Math.max(4 * 1024, maxAssistantKb * 1024);
  const extractor = new StreamingMetadataExtractor(maxAssistantBytes);

  logger.info("pi pre-launch", {
    commandPreview: preview.commandPreview,
    argvPreview: preview.argvPreview,
    redactedIndices: preview.redactedIndices,
    truncatedIndices: preview.truncatedIndices,
    promptElided: preview.promptElided,
    argCount: preview.argCount,
    timeoutMs,
    workdir: options.workdir,
    outputFile,
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
    outputFile,
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

  // Stream stdout to disk while extracting metadata in real-time
  await streamStdoutWithExtractor(child.stdout!, outputFile, extractor);

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
  const metadata = extractor.getMetadata();

  if (stderrMeta.preview) {
    logger.warn("pi stderr", {
      pid: childPid ?? null,
      stderrBytes: stderrMeta.bytes,
      stderrPreview: stderrMeta.preview,
      stderrTruncated: stderrMeta.truncated,
    });
  }

  const stdoutMeta = buildStreamLogMetadata(metadata.assistantTextTail);

  logger.info("pi completed", {
    pid: childPid ?? null,
    pgid,
    durationMs,
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdoutBytes: metadata.totalBytesIngested,
    stdoutRetainedBytes: stdoutMeta.bytes,
    stdoutPreview: stdoutMeta.preview,
    outputTruncatedByBuffer: metadata.assistantTextTruncated,
    linesDropped: metadata.linesDropped,
    statusMarker: metadata.statusMarker,
    tokenUsage: metadata.tokenUsage,
    jsonMetadataDetected: metadata.jsonMetadataDetected,
  });

  if (metadata.assistantTextTruncated) {
    logger.warn("pi output exceeded buffer capacity — only tail retained", {
      pid: childPid ?? null,
      totalBytesIngested: metadata.totalBytesIngested,
      linesDropped: metadata.linesDropped,
      retainedBytes: stdoutMeta.bytes,
    });
  }

  // Clean up temp output file unless FORMIGA_KEEP_PI_OUTPUT is set
  const shouldKeep = process.env.FORMIGA_KEEP_PI_OUTPUT === "1" || process.env.FORMIGA_KEEP_PI_OUTPUT === "true";
  if (!shouldKeep && !options.outputFile) {
    try {
      await fs.promises.unlink(outputFile);
    } catch {
      // best effort — file may already be deleted
    }
  }

  return {
    metadata,
    assistantText: metadata.assistantTextTail,
    outputFile,
    durationMs,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}
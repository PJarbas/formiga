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
import { processActivityLine, type ActivityContext } from "./activity-recorder.js";
import { createActivityTimeout } from "./activity-timeout.js";

export interface RunPiOptions {
  timeout?: number; // seconds, default 60; ignored when hardTimeoutMs is set
  /**
   * Absolute wall-clock cap in ms — never re-armed regardless of activity.
   * When set together with staleTimeoutMs, `timeout` is ignored.
   */
  hardTimeoutMs?: number;
  /**
   * Idle threshold in ms — re-arms the expiry timer on every stdout chunk.
   * Only meaningful with hardTimeoutMs.
   */
  staleTimeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
  /**
   * Activity context for recording tool calls to the database.
   * When provided, tool calls are recorded in real-time for dashboard visualization.
   */
  activityContext?: ActivityContext;
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
  activityContext?: ActivityContext,
  onActivity?: () => void,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
  const writeStream = fs.createWriteStream(outputFile);

  try {
    for await (const chunk of stdout) {
      onActivity?.();
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

          // Record activity to database (fire-and-forget)
          if (activityContext) {
            processActivityLine(line, activityContext).catch(() => {
              // Ignore errors - activity recording is best-effort
            });
          }
        }
      }
    }
  } finally {
    // Always flush whatever was consumed to disk, even when the pipe is torn
    // down because the child exited while a grandchild (pi tool/session
    // process) still held the stdout fd open.
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      writeStream.end();
    });
  }

  // M-4: drain the activity-recording batch queue at stream end so nothing
  // buffered during this run is lost when the stream closes.
  const { flushAgentEventQueue } = await import("../../server/routes/agent-activity.js");
  await flushAgentEventQueue().catch(() => {
    // Activity recording is best-effort — a failed drain must not fail the run.
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

  // Capture spawn failures early (ENOENT/EACCES etc.). Without a listener
  // Node emits an unhandled 'error' and crashes the daemon; we want runPi
  // to reject instead. child.stdout is null in that case, so the stream
  // below would otherwise throw an opaque TypeError over the real cause.
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });

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

  // CR-4: the timeout guard is installed immediately after spawn and covers
  // the WHOLE invocation (streaming + exit wait), racing the work below.
  // Previously the guard was only installed after streamStdoutWithExtractor
  // resolved, so a wedged run whose stdout never closes escaped the timeout
  // entirely and ran forever.
  //
  // Dynamic guard (arena): when hardTimeoutMs/staleTimeoutMs are provided, a
  // fixed wall-clock kill is replaced by an absolute hard cap PLUS a stale
  // threshold re-armed on every stdout chunk — an agent that keeps producing
  // output (tool calls) is working and must not be killed, while a silent one
  // dies on the stale threshold. Without those options the legacy single
  // timeout applies unchanged.
  let timedOut = false;
  let rejectTimeout!: (err: Error) => void;
  const timeoutGuard = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const killProcessGroup = (): void => {
    // Terminate the whole process group: SIGTERM, then SIGKILL after 5s.
    if (pgid) {
      safeKillPgid(pgid, "SIGTERM");
      setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
    } else {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    }
  };
  const effectiveHardMs = options.hardTimeoutMs ?? timeoutMs;
  const activityTimeout = createActivityTimeout(
    { hardMs: effectiveHardMs, staleMs: options.staleTimeoutMs },
    () => {
      timedOut = true;
      logger.warn("pi timed out — killed process group", {
        pid: childPid ?? null,
        pgid,
        hardMs: effectiveHardMs,
        staleMs: options.staleTimeoutMs ?? null,
      });
      killProcessGroup();
      rejectTimeout(
        new Error(
          `pi timed out after ${effectiveHardMs}ms` +
          (options.staleTimeoutMs ? ` (no output for ${options.staleTimeoutMs}ms)` : ""),
        ),
      );
    },
  );

  // Track exit BEFORE streaming. Listen for 'exit', NOT 'close': 'close' only
  // fires after the stdio streams have closed, which never happens while a
  // grandchild (pi tool/session process) holds the stdout fd open — the
  // chronic arena hang. 'exit' fires the moment the main process is gone, so
  // the race below can resolve and tear the pipe down. A child that dies
  // while the stream is being consumed (timeout kill, crash) can emit 'exit'
  // before we'd otherwise attach the listener — attaching here closes that
  // race.
  let settleExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    settleExit = (code, signal) => resolve({ code, signal });
  });
  child.once("exit", (code, signal) => settleExit(code, signal));

  // Stream stdout while waiting for exit, racing the timeout guard so a
  // wedged stream still dies on time (CR-4). On any stream rejection kill
  // the group so the child can't outlive runPi (CR-5), then surface the
  // most useful cause: timeout, spawn failure, or the stream error.
  try {
    const exitSignal = await Promise.race([
      (async () => {
        try {
          await streamStdoutWithExtractor(
            child.stdout!,
            outputFile,
            extractor,
            options.activityContext,
            () => activityTimeout.notifyActivity(),
          );
        } catch (err) {
          if (!timedOut) killProcessGroup();
          throw spawnError ?? err;
        }
        return await exitPromise;
      })(),
      // Resolve the moment the main process exits, even if the stdout pipe is
      // still held open by a grandchild (pi tool/session processes that
      // inherit the fd). `for await (const chunk of stdout)` only resolves when
      // the pipe closes, so without this exit-driven branch runPi would wedge
      // forever after pi exits — the chronic arena hang. Teardown both pipes
      // so the drain loop and the bounded stderr collector can end; a
      // grandchild holding the fds open would otherwise keep this process
      // alive forever. The loop has already consumed everything the child
      // wrote before exiting, so the transcript on disk is complete.
      (async () => {
        const exit = await exitPromise;
        setImmediate(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
        return exit;
      })(),
      timeoutGuard,
    ]);
    const { code, signal } = exitSignal;
    if (code !== 0 && code !== null) {
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
      throw new Error(`pi failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`);
    }
  } finally {
    activityTimeout.clear();
  }

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
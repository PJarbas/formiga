// ══════════════════════════════════════════════════════════════════════
// harness-hermes-runner.ts — HermesRunner: HarnessRunner for hermes binary
// ══════════════════════════════════════════════════════════════════════
//
// Thin wrapper around the existing runHermes() function. Hermes returns
// plain text (no JSON streaming), so we construct a synthetic
// ExtractedMetadata with jsonMetadataDetected: false and extract the
// STATUS marker via regex from the raw output.
//
// runHermes() itself is NOT modified — this is a zero-risk adapter.
// ══════════════════════════════════════════════════════════════════════

import { logger } from "../../lib/logger.js";
import { runHermes } from "./hermes-runner.js";
import type { HarnessOptions, HarnessResult, HarnessRunner, HarnessRunnerConfig } from "./harness-runner.js";
import type { ExtractedMetadata } from "./streaming-metadata-extractor.js";

/** Regex to extract STATUS: done | failed | error markers from plain text. */
const STATUS_MARKER_RE = /^STATUS:\s*(done|failed|error)\s*$/im;

function buildSyntheticMetadata(rawText: string, durationMs: number): ExtractedMetadata {
  const statusMatch = rawText.match(STATUS_MARKER_RE);

  return {
    statusMarker: statusMatch ? statusMatch[1].toLowerCase() : null,
    tokenUsage: null,                    // hermes doesn't report token usage in text
    runId: null,
    stepId: null,
    jsonMetadataDetected: false,         // plain-text harness
    assistantTextTail: rawText.slice(-4096),  // bounded tail (4 KB)
    assistantTextTruncated: rawText.length > 4096,
    totalBytesIngested: Buffer.byteLength(rawText, "utf-8"),
    totalLines: rawText.split("\n").length,
    linesDropped: 0,
    harness: "hermes",
  };
}

export class HermesRunner implements HarnessRunner {
  readonly type = "hermes";

  private readonly binaryPath?: string;
  private readonly runnerEnv?: Record<string, string>;

  constructor(config?: HarnessRunnerConfig) {
    this.binaryPath = config?.binaryPath;
    this.runnerEnv = config?.env;
  }

  async run(prompt: string, options: HarnessOptions = {}): Promise<HarnessResult> {
    const startedAt = Date.now();

    // Merge config-level env into invocation-level env.
    const mergedEnv: Record<string, string> = {
      ...(this.runnerEnv ?? {}),
      ...(options.env ?? {}),
    };

    if (this.binaryPath) {
      mergedEnv.FORMIGA_HERMES_BINARY = this.binaryPath;
    }

    logger.debug("HermesRunner.run", {
      binaryPath: this.binaryPath ?? null,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      timeout: options.timeout,
      workdir: options.workdir,
      outputFile: options.outputFile ?? null,
    });

    const rawText = await runHermes(prompt, {
      timeout: options.timeout,
      workdir: options.workdir,
      env: mergedEnv,
      onSpawn: options.onSpawn,
      outputFile: options.outputFile,
      activityContext: options.activityContext,
    });

    const durationMs = Date.now() - startedAt;
    const metadata = buildSyntheticMetadata(rawText, durationMs);

    return {
      assistantText: rawText,
      metadata,
      outputFile: options.outputFile ?? "",
      durationMs,
      exitCode: 0,      // runHermes throws on non-zero, so this is always 0
      signalCode: null,
    };
  }
}

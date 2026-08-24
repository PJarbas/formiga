// ══════════════════════════════════════════════════════════════════════
// harness-pi-runner.ts — PiRunner: HarnessRunner for pi binary
// ══════════════════════════════════════════════════════════════════════
//
// Thin wrapper around the existing runPi() function. Builds pi args
// from the prompt + harness config, delegates to runPi, and maps
// RunPiResult → HarnessResult 1:1.
//
// runPi() itself is NOT modified — this is a zero-risk adapter.
// ══════════════════════════════════════════════════════════════════════

import { logger } from "../../lib/logger.js";
import { runPi } from "./pi-runner.js";
import type { HarnessOptions, HarnessResult, HarnessRunner, HarnessRunnerConfig } from "./harness-runner.js";

export class PiRunner implements HarnessRunner {
  readonly type = "pi";

  private readonly binaryPath?: string;
  private readonly runnerEnv?: Record<string, string>;
  private readonly extensionPath?: string;

  constructor(config?: HarnessRunnerConfig) {
    this.binaryPath = config?.binaryPath;
    this.runnerEnv = config?.env;
    this.extensionPath = config?.harnessSpecific?.extensionPath as string | undefined;
  }

  async run(prompt: string, options: HarnessOptions = {}): Promise<HarnessResult> {
    const piArgs: string[] = [];

    // Extension path from config (--extension loads custom tools).
    if (this.extensionPath) {
      piArgs.push("--extension", this.extensionPath);
    }

    // Core args: print output, json streaming, no session reuse, prompt.
    piArgs.push("--print", "--mode", "json", "--no-session", prompt);

    // Merge config-level env into invocation-level env.
    const mergedEnv: Record<string, string> = {
      ...(this.runnerEnv ?? {}),
      ...(options.env ?? {}),
    };

    logger.debug("PiRunner.run", {
      extensionPath: this.extensionPath ?? null,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      timeout: options.timeout,
      workdir: options.workdir,
      outputFile: options.outputFile ?? null,
    });

    const result = await runPi(piArgs, {
      timeout: options.timeout,
      hardTimeoutMs: options.hardTimeoutMs,
      staleTimeoutMs: options.staleTimeoutMs,
      workdir: options.workdir,
      env: mergedEnv,
      activityContext: options.activityContext,
      onSpawn: options.onSpawn,
      outputFile: options.outputFile,
    });

    return {
      assistantText: result.assistantText,
      metadata: result.metadata,         // ExtractedMetadata — 1:1
      outputFile: result.outputFile,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signalCode: result.signalCode,
    };
  }
}

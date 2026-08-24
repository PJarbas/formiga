// ══════════════════════════════════════════════════════════════════════
// harness-opencode-runner.ts — OpencodeRunner: HarnessRunner for opencode
// ══════════════════════════════════════════════════════════════════════
//
// Thin wrapper around the low-level runOpencode() function. Builds opencode
// args (`run <prompt> --pure --auto -m <model>`) from the prompt + harness
// config, delegates to runOpencode, and maps RunOpencodeResult →
// HarnessResult 1:1.
//
// runOpencode() itself is NOT modified — this is a zero-risk adapter,
// mirroring PiRunner/harness-pi-runner.ts.
//
// opencode streams its output (unlike claude-code, which buffers), so it
// fits the watchdog-friendly StreamingMetadataExtractor pattern and is a
// viable pi replacement.
// ══════════════════════════════════════════════════════════════════════

import { logger } from "../../lib/logger.js";
import { runOpencode } from "./opencode-runner.js";
import type { HarnessOptions, HarnessResult, HarnessRunner, HarnessRunnerConfig } from "./harness-runner.js";

/** Default model used when none is configured (see bench: deepseek-v4-flash-official). */
const DEFAULT_OPENCODE_MODEL = "ifood-chat-completions/deepseek-v4-flash-official";

export class OpencodeRunner implements HarnessRunner {
  readonly type = "opencode";

  private readonly binaryPath?: string;
  private readonly runnerEnv?: Record<string, string>;
  private readonly model: string;

  constructor(config?: HarnessRunnerConfig) {
    this.binaryPath = config?.binaryPath;
    this.runnerEnv = config?.env;
    const specific = config?.harnessSpecific as Record<string, unknown> | undefined;
    const configuredModel =
      (typeof specific?.model === "string" && specific.model.length > 0 ? specific.model : undefined) ??
      process.env.FORMIGA_OPENCODE_MODEL?.trim() ??
      DEFAULT_OPENCODE_MODEL;
    this.model = configuredModel;
  }

  async run(prompt: string, options: HarnessOptions = {}): Promise<HarnessResult> {
    // Core args: run the prompt non-interactively with a fixed model.
    const opencodeArgs: string[] = ["run", prompt, "--pure", "--auto", "-m", this.model];

    // Merge config-level env into invocation-level env.
    const mergedEnv: Record<string, string> = {
      ...(this.runnerEnv ?? {}),
      ...(options.env ?? {}),
    };

    logger.debug("OpencodeRunner.run", {
      binaryPath: this.binaryPath ?? null,
      model: this.model,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      timeout: options.timeout,
      workdir: options.workdir,
      outputFile: options.outputFile ?? null,
    });

    const result = await runOpencode(opencodeArgs, {
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

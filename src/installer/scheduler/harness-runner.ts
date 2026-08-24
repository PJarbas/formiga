// ══════════════════════════════════════════════════════════════════════
// harness-runner.ts — HarnessRunner interface + factory
// ══════════════════════════════════════════════════════════════════════
//
// Abstract over harness binaries (pi, hermes, claude-code, opencode, …)
// so the scheduler and arena engine never call harness-specific functions
// directly. The factory createHarnessRunner(type, config) returns a
// HarnessRunner whose single `run(prompt, options)` method is the only
// contract the rest of the system depends on.
//
// Existing low-level functions (runPi, runHermes) are NOT modified —
// PiRunner and HermesRunner are thin wrappers implemented in separate
// files. Static imports are safe because the runner classes only import
// TypeScript types from this module (erased at compile time).
//
// HarnessResult reuses ExtractedMetadata from streaming-metadata-extractor.ts
// directly — no new types, no translation layer. Each runner populates what
// the underlying harness can provide; runners for text-only harnesses
// (hermes, claude-code) populate a synthetic ExtractedMetadata with
// jsonMetadataDetected: false.
// ══════════════════════════════════════════════════════════════════════

import type { ActivityContext } from "./activity-recorder.js";
import type { ExtractedMetadata } from "./streaming-metadata-extractor.js";

// ── Public types ──────────────────────────────────────────────────────

/** Options passed to every HarnessRunner.run() call. */
export interface HarnessOptions {
  /** Timeout in seconds (default 60). Ignored when hardTimeoutMs is set. */
  timeout?: number;
  /**
   * Absolute wall-clock cap in ms — never re-armed, regardless of activity.
   * Overrides `timeout` semantics (which becomes the stale/idle threshold
   * paired with staleTimeoutMs). Used for dynamic arena agent timeouts.
   */
  hardTimeoutMs?: number;
  /**
   * Idle threshold in ms: re-arms the expiry timer on every stdout chunk.
   * Only meaningful together with hardTimeoutMs. When omitted, the child is
   * killed solely by the hard cap (legacy behavior).
   */
  staleTimeoutMs?: number;
  /** Working directory for the harness process. */
  workdir?: string;
  /** Environment variables injected into the harness process. */
  env?: Record<string, string>;
  /** Activity context for DB recording (runId, stepId, agentId). */
  activityContext?: ActivityContext;
  /** Called with pid/pgid after spawn — used to stamp claim_pid on steps. */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  /** File path to stream stdout to (disk-backed mode, bounded memory). */
  outputFile?: string;
}

/** Unified result returned by every harness runner. */
export interface HarnessResult {
  /** The core assistant text output (prompt response, script, report, …). */
  assistantText: string;
  /** Structured metadata extracted from the harness output stream. */
  metadata: ExtractedMetadata;
  /** Path to the on-disk output file (when outputFile option is used). */
  outputFile: string;
  /** Wall-clock duration of the harness invocation in milliseconds. */
  durationMs: number;
  /** Process exit code (null if killed by signal before exit). */
  exitCode: number | null;
  /** Signal name that killed the process (null if normal exit). */
  signalCode: string | null;
}

/** A harness that can execute prompts. */
export interface HarnessRunner {
  /** Harness identifier ("pi", "hermes", …). */
  readonly type: string;
  /** Execute a prompt through this harness. */
  run(prompt: string, options?: HarnessOptions): Promise<HarnessResult>;
}

/** Construction-time configuration for a HarnessRunner. */
export interface HarnessRunnerConfig {
  /** Path to the harness binary (optional — resolved lazily when omitted). */
  binaryPath?: string;
  /** Additional environment variables for every invocation. */
  env?: Record<string, string>;
  /** Harness-specific options (e.g. PI extensionPath). */
  harnessSpecific?: Record<string, unknown>;
}

// ── Factory ───────────────────────────────────────────────────────────

import { PiRunner } from "./harness-pi-runner.js";
import { HermesRunner } from "./harness-hermes-runner.js";
import { OpencodeRunner } from "./harness-opencode-runner.js";

/**
 * Create a HarnessRunner for the given harness type.
 *
 * Supported types:
 *   "pi"       → PiRunner       (wraps runPi from pi-runner.ts)
 *   "hermes"   → HermesRunner   (wraps runHermes from hermes-runner.ts)
 *   "opencode" → OpencodeRunner (wraps runOpencode from opencode-runner.ts)
 *
 * Static imports are safe because the runner classes only import
 * TypeScript types from this module — those are erased at compile time,
 * so there is no runtime circular dependency.
 */
export function createHarnessRunner(
  type: string,
  config?: HarnessRunnerConfig,
): HarnessRunner {
  switch (type) {
    case "pi":
      return new PiRunner(config);
    case "hermes":
      return new HermesRunner(config);
    case "opencode":
      return new OpencodeRunner(config);
    default:
      throw new Error(
        `Unknown harness type: "${type}". Supported: pi, hermes, opencode.`,
      );
  }
}

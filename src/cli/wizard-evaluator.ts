/**
 * Pi JSON evaluator for the AutoResearch wizard.
 *
 * Spawns pi as a subprocess with --print --no-session --mode json,
 * parses the JSONL stdout to extract final assistant text, and
 * validates the result against WizardEvaluatorNotReady or
 * WizardEvaluatorReady shapes.
 */

import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { parsePiOutputStream, type PiOutputStreamResult } from "../installer/pi-stream-parser.js";
import type {
  WizardEvaluatorNotReady,
  WizardEvaluatorReady,
} from "./wizard-types.js";
import { logger } from "../lib/logger.js";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Injectable spawn function matching child_process.spawn signature.
 * Accepts (command, args, options) and returns a ChildProcess.
 */
export type PiSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

// ── JSON extraction ─────────────────────────────────────────────────

/**
 * Strip a single optional ```json fenced block from the assistant text.
 *
 * Handles:
 * - Pure JSON: `{"ready": false, ...}`
 * - Fenced JSON: ```json\n{"ready": false, ...}\n```
 */
export function extractJsonFromAssistantText(text: string): string {
  const trimmed = text.trim();

  // Check for fenced block pattern
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return trimmed;
}

// ── Validation ──────────────────────────────────────────────────────

function validateNotReady(obj: unknown): WizardEvaluatorNotReady {
  if (typeof obj !== "object" || obj === null) {
    throw new Error(`Expected a JSON object, got ${typeof obj}`);
  }

  const record = obj as Record<string, unknown>;

  if (record.ready !== false) {
    throw new Error(
      `Expected ready: false, got ${JSON.stringify(record.ready)}`,
    );
  }

  if (typeof record.question !== "string" || record.question.length === 0) {
    throw new Error(`Missing or invalid "question" field`);
  }

  if (typeof record.reason !== "string" || record.reason.length === 0) {
    throw new Error(`Missing or invalid "reason" field`);
  }

  return {
    ready: false,
    question: record.question,
    reason: record.reason,
  };
}

function validateReady(obj: unknown): WizardEvaluatorReady {
  if (typeof obj !== "object" || obj === null) {
    throw new Error(`Expected a JSON object, got ${typeof obj}`);
  }

  const record = obj as Record<string, unknown>;

  if (record.ready !== true) {
    throw new Error(
      `Expected ready: true, got ${JSON.stringify(record.ready)}`,
    );
  }

  if (typeof record.commentary !== "string" || record.commentary.length === 0) {
    throw new Error(`Missing or invalid "commentary" field`);
  }

  if (typeof record.needsInit !== "boolean") {
    throw new Error(
      `Missing or invalid "needsInit" field (expected boolean)`,
    );
  }

  if (!Array.isArray(record.loopArgv)) {
    throw new Error(`Missing or invalid "loopArgv" field (expected array)`);
  }

  const loopArgv = record.loopArgv.map((item, idx) => {
    if (typeof item !== "string") {
      throw new Error(
        `loopArgv[${idx}] is not a string: ${JSON.stringify(item)}`,
      );
    }
    return item;
  });

  if (loopArgv.length === 0) {
    throw new Error(`loopArgv must not be empty`);
  }

  let initArgv: string[] | null = null;
  if (record.needsInit === true) {
    if (record.initArgv === undefined || record.initArgv === null) {
      throw new Error(
        `needsInit is true but initArgv is missing or null`,
      );
    }
    if (!Array.isArray(record.initArgv)) {
      throw new Error(
        `needsInit is true but initArgv is not an array`,
      );
    }
    initArgv = (record.initArgv as unknown[]).map((item, idx) => {
      if (typeof item !== "string") {
        throw new Error(
          `initArgv[${idx}] is not a string: ${JSON.stringify(item)}`,
        );
      }
      return item;
    });
    if (initArgv.length === 0) {
      throw new Error(`initArgv must not be empty when needsInit is true`);
    }
  }

  const result: WizardEvaluatorReady = {
    ready: true,
    commentary: record.commentary,
    needsInit: record.needsInit,
    loopArgv,
    ...(initArgv !== null ? { initArgv } : {}),
  };

  return result;
}

// ── Main API ────────────────────────────────────────────────────────

/**
 * Process the raw assistant text from pi's output into a validated
 * evaluator response. Pure function — no I/O, no streams.
 *
 * @param assistantText - Raw assistant text from pi's message_end event.
 * @param exitCode - pi's exit code (for error messages).
 * @param stderr - pi's stderr output (for error messages).
 * @returns Either WizardEvaluatorNotReady or WizardEvaluatorReady.
 * @throws If the text cannot be parsed into a valid evaluator response.
 */
export function processWizardAssistantText(
  assistantText: string,
  exitCode: number | null,
  stderr: string,
): WizardEvaluatorNotReady | WizardEvaluatorReady {
  // Extract JSON from assistant text
  const jsonText = extractJsonFromAssistantText(assistantText);

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse pi JSON response: ${
        err instanceof Error ? err.message : String(err)
      }\nRaw text: ${jsonText.substring(0, 500)}`,
    );
  }

  // Validate shape
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Expected a JSON object from pi, got ${typeof parsed}`,
    );
  }

  const record = parsed as Record<string, unknown>;

  if (record.ready === true) {
    return validateReady(parsed);
  } else if (record.ready === false) {
    return validateNotReady(parsed);
  } else {
    throw new Error(
      `Unknown "ready" value from pi: ${JSON.stringify(record.ready)}. Expected true or false.`,
    );
  }
}

/**
 * Evaluate wizard response by spawning pi as a subprocess.
 *
 * Spawns `pi --print --no-session --mode json <prompt>`, reads JSONL
 * output from stdout, extracts the final assistant text via
 * parsePiOutputStream, strips an optional ```json fence, and
 * validates the result shape.
 *
 * @param piSpawn - Injectable spawn function (for testing).
 * @param cwd - Working directory.
 * @param prompt - The evaluator prompt to send to pi.
 * @returns Either WizardEvaluatorNotReady or WizardEvaluatorReady.
 * @throws If pi fails to spawn, produces no assistant text, returns
 *         unparseable JSON, or returns a shape that doesn't match the
 *         expected types.
 */
export async function evaluateWizardResponse(
  piSpawn: PiSpawnFn,
  cwd: string,
  prompt: string,
): Promise<WizardEvaluatorNotReady | WizardEvaluatorReady> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const child = piSpawn(
      "pi",
      ["--print", "--no-session", "--mode", "json", prompt],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );

    // Collect stdout and stderr as raw buffers
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
    }

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn pi: ${err.message}`));
    });

    child.on("close", async (code: number | null) => {
      if (settled) return;
      settled = true;

      try {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const lines = stdout.split("\n").filter((l) => l.length > 0);

        const result: PiOutputStreamResult = await parsePiOutputStream(lines);

        if (!result.assistantText) {
          const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
          const details = stderr ? ` stderr: ${stderr}` : "";
          throw new Error(
            `pi produced no assistant text (exit code ${code ?? "null"}).${details}`,
          );
        }

        logger.debug("Wizard evaluator: extracted assistant text", {
          assistantTextLength: result.assistantText.length,
          assistantTextPreview: result.assistantText.substring(0, 200),
        });

        resolve(processWizardAssistantText(
          result.assistantText,
          code,
          Buffer.concat(stderrChunks).toString("utf-8").trim(),
        ));
      } catch (err: unknown) {
        reject(err);
      }
    });
  });
}

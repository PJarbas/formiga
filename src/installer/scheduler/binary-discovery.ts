// ══════════════════════════════════════════════════════════════════════
// binary-discovery.ts — Locate pi / hermes binaries on disk
// ══════════════════════════════════════════════════════════════════════
//
// Resolution order for each binary:
//   1. Explicit env override (FORMIGA_PI_BINARY / FORMIGA_HERMES_BINARY)
//   2. Each directory on PATH
// Throws if neither yields an executable.
//
// Also exposes two thin orphan-replacement stubs (formatPiCommandPreview,
// parsePiOutputStream) that survive only to keep the legacy pi/hermes
// spawn paths type-clean until Branch 5 replaces the execution model.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import type { Interface as ReadlineInterface } from "node:readline";

// ── pi binary discovery ────────────────────────────────────────────────

export async function findPiBinary(): Promise<string> {
  // Prefer explicit env override
  const envPi = process.env.FORMIGA_PI_BINARY?.trim();
  if (envPi) {
    try {
      fs.accessSync(envPi, fs.constants.X_OK);
      return envPi;
    } catch {
      throw new Error(`FORMIGA_PI_BINARY set but not executable: ${envPi}`);
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "pi");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }

  throw new Error(
    "pi binary not found in PATH. Install pi (https://github.com/anthropics/pi) or set FORMIGA_PI_BINARY."
  );
}

// ── hermes binary discovery ────────────────────────────────────────────

export function findHermesBinary(): string {
  // Prefer explicit env override
  const envHermes = process.env.FORMIGA_HERMES_BINARY?.trim();
  if (envHermes) {
    try {
      fs.accessSync(envHermes, fs.constants.X_OK);
      return envHermes;
    } catch {
      throw new Error(
        `FORMIGA_HERMES_BINARY set but not executable: ${envHermes}`
      );
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "hermes");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }

  throw new Error(
    "hermes binary not found in PATH. Install hermes or set FORMIGA_HERMES_BINARY."
  );
}

// ── Inline stubs for previously-imported orphan helpers ────────────────
//
// formatPiCommandPreview and parsePiOutputStream were removed as orphan
// code. Branch 5 (ML agents) replaces the entire pi/hermes execution
// model, so these stubs only exist to keep the legacy spawn paths
// type-clean until that branch lands.

export interface PiCommandPreview {
  commandPreview: string;
  argvPreview: string[];
  redactedIndices: number[];
  truncatedIndices: number[];
  promptElided: boolean;
  argCount: number;
}

export function formatPiCommandPreview(binPath: string, args: string[]): PiCommandPreview {
  return {
    commandPreview: [binPath, ...args].join(" "),
    argvPreview: args,
    redactedIndices: [],
    truncatedIndices: [],
    promptElided: false,
    argCount: args.length,
  };
}

export interface ParsePiResult {
  assistantText: string;
  textFallback: string | null;
  events: unknown[];
}

export async function parsePiOutputStream(rl: ReadlineInterface): Promise<ParsePiResult> {
  const lines: string[] = [];
  let totalBytes = 0;
  const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB cap to prevent V8 string length overflow

  for await (const line of rl) {
    totalBytes += line.length + 1;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      lines.push("[… output truncated — exceeded 50 MB]");
      break;
    }
    lines.push(line);
  }
  return {
    assistantText: lines.join("\n"),
    textFallback: null,
    events: [],
  };
}

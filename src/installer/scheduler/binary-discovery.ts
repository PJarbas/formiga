// ══════════════════════════════════════════════════════════════════════
// binary-discovery.ts — Locate pi / hermes binaries on disk
// ══════════════════════════════════════════════════════════════════════
//
// Resolution order for each binary:
//   1. Explicit env override (FORMIGA_PI_BINARY / FORMIGA_HERMES_BINARY)
//   2. Each directory on PATH
// Throws if neither yields an executable.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

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

// ── Command preview (for logging) ──────────────────────────────────────

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

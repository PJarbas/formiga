// ══════════════════════════════════════════════════════════════════════
// validation.ts — Runtime guards and value validators (no external deps)
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";

/** Throw with a descriptive message when condition is false. */
export function failFast(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Assert value is a non-empty string. */
export function requireNonEmptyString(value: unknown, label: string): string {
  failFast(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}

/** Assert value is a positive number. */
export function requirePositiveNumber(value: unknown, label: string): number {
  failFast(typeof value === "number" && !Number.isNaN(value) && value >= 0, `${label} must be a non-negative number`);
  return value;
}

/** Assert value is an array with length in [minLen, maxLen]. */
export function requireArray<T>(value: unknown, label: string, minLen = 0, maxLen = Infinity): T[] {
  failFast(Array.isArray(value), `${label} must be an array`);
  failFast(value.length >= minLen, `${label} must have at least ${minLen} elements`);
  failFast(value.length <= maxLen, `${label} must have at most ${maxLen} elements`);
  return value as T[];
}

/** Validate a filesystem path exists (optional mustExist check). */
export function validatePath(p: string, mustExist = false): string {
  failFast(typeof p === "string" && p.trim().length > 0, "Path must be a non-empty string");
  if (mustExist) {
    failFast(fs.existsSync(p), `Path does not exist: ${p}`);
  }
  return p;
}

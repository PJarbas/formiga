import { execFileSync } from "node:child_process";

// ══════════════════════════════════════════════════════════════════════
// Key-Value Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse KEY: value lines from step output with support for multi-line values.
 * Accumulates continuation lines until the next KEY: boundary or end of output.
 * Returns a map of lowercase keys to their (trimmed) values.
 * Skips STORIES_JSON keys (handled separately).
 */
export function parseOutputKeyValues(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split("\n");
  let pendingKey: string | null = null;
  let pendingValue = "";

  function commitPending() {
    if (pendingKey && !pendingKey.startsWith("STORIES_JSON")) {
      result[pendingKey.toLowerCase()] = pendingValue.trim();
    }
    pendingKey = null;
    pendingValue = "";
  }

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match) {
      commitPending();
      pendingKey = match[1];
      pendingValue = match[2];
    } else if (pendingKey) {
      pendingValue += "\n" + line;
    }
  }
  commitPending();

  return result;
}

/**
 * Reserved context keys that must not be overwritten by step output parsing.
 * These are structural keys that define the harness/repo/environment and should
 * only be set during run creation, not by agent-generated KEY:value output.
 */
export const RESERVED_CONTEXT_KEYS = new Set([
  "repo",
  "working_directory_for_harness",
  "workspace",
  "task",
  "run_id",
  "workspace_mode",
  "worktree_path",
  "worktree_origin_repository",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "original_branch",
]);

// ══════════════════════════════════════════════════════════════════════
// Template Resolution
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve {{key}} placeholders in a template against a context object.
 */
export function resolveTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (key in context) return context[key];
    const lower = key.toLowerCase();
    if (lower in context) return context[lower];
    return `[missing: ${key}]`;
  });
}

/**
 * Find missing template placeholders for a given context object.
 */
export function findMissingTemplateKeys(template: string, context: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const lower = key.toLowerCase();
    const hasExact = Object.prototype.hasOwnProperty.call(context, key);
    const hasLower = Object.prototype.hasOwnProperty.call(context, lower);
    if (!hasExact && !hasLower && !seen.has(lower)) {
      seen.add(lower);
      missing.push(lower);
    }
    return "";
  });
  return missing;
}

// ══════════════════════════════════════════════════════════════════════
// Frontend Detection (Pi/Hermes legacy stub + helper used by claimStep)
// ══════════════════════════════════════════════════════════════════════

function isFrontendChange(files: string[]): boolean {
  const FRONTEND_PATTERNS = [/\.tsx?$/, /\.jsx?$/, /\.css$/, /\.scss$/, /\.html$/, /\.vue$/, /\.svelte$/];
  return files.some((f) => FRONTEND_PATTERNS.some((pat) => pat.test(f)));
}

/**
 * Compute whether a branch has frontend changes relative to main.
 * Returns 'true' or 'false' as a string for template context.
 */
export function computeHasFrontendChanges(repo: string, branch: string): string {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `main..${branch}`], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const files = output.trim().split("\n").filter((f) => f.length > 0);
    return isFrontendChange(files) ? "true" : "false";
  } catch {
    return "false";
  }
}

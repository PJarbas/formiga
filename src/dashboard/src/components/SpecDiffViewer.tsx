// ══════════════════════════════════════════════════════════════════════
// SpecDiffViewer.tsx — Render a before/after diff inline, no deps
// ──────────────────────────────────────────────────────────────────────
// Uses a small LCS (Longest Common Subsequence) line-diff. Suitable
// for short specs (< ~200 lines). For larger payloads, swap in a real
// diff library — the component boundary is isolated.
// ══════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import type { DiffHunk } from "@shared/dashboard-types";

export interface SpecDiffViewerProps {
  before: string;
  after: string;
  /** "unified" inline (default) or "split" two-column. */
  format?: "unified" | "split";
}

/**
 * Compute a line-level LCS diff. Returns hunks tagged added/removed/unchanged.
 * O(n*m) time and space — fine for short specs.
 */
export function computeLineDiff(beforeStr: string, afterStr: string): DiffHunk[] {
  const a = beforeStr.split("\n");
  const b = afterStr.split("\n");
  const n = a.length;
  const m = b.length;

  // Build LCS table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Backtrack to produce hunks.
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  let lineNum = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      hunks.push({ type: "unchanged", content: a[i], lineNumber: lineNum++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      hunks.push({ type: "removed", content: a[i], lineNumber: lineNum++ });
      i++;
    } else {
      hunks.push({ type: "added", content: b[j], lineNumber: lineNum++ });
      j++;
    }
  }
  while (i < n) {
    hunks.push({ type: "removed", content: a[i++], lineNumber: lineNum++ });
  }
  while (j < m) {
    hunks.push({ type: "added", content: b[j++], lineNumber: lineNum++ });
  }
  return hunks;
}

export function SpecDiffViewer({ before, after, format = "unified" }: SpecDiffViewerProps) {
  const [mode, setMode] = useState<"unified" | "split">(format);
  const hunks = useMemo(() => computeLineDiff(before, after), [before, after]);

  return (
    <div data-testid="spec-diff-viewer" className="border border-[var(--border-default)] rounded">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <span className="text-xs text-[var(--text-secondary)] uppercase tracking-wide">
          Spec diff
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            data-testid="diff-mode-unified"
            onClick={() => setMode("unified")}
            className={`px-2 py-0.5 rounded text-xs ${
              mode === "unified"
                ? "bg-[var(--accent-blue)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Unified
          </button>
          <button
            type="button"
            data-testid="diff-mode-split"
            onClick={() => setMode("split")}
            className={`px-2 py-0.5 rounded text-xs ${
              mode === "split"
                ? "bg-[var(--accent-blue)] text-white"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Split
          </button>
        </div>
      </div>

      {mode === "unified" ? (
        <pre className="font-mono text-xs p-3 m-0 overflow-x-auto" data-testid="diff-unified">
          {hunks.map((h, idx) => {
            const prefix = h.type === "added" ? "+" : h.type === "removed" ? "-" : " ";
            const color =
              h.type === "added"
                ? "var(--accent-green)"
                : h.type === "removed"
                  ? "var(--accent-red)"
                  : "var(--text-secondary)";
            return (
              <div
                key={idx}
                data-hunk-type={h.type}
                style={{ color }}
              >
                {prefix} {h.content}
              </div>
            );
          })}
        </pre>
      ) : (
        <div className="grid grid-cols-2 gap-px bg-[var(--border-default)]" data-testid="diff-split">
          <pre className="font-mono text-xs p-3 m-0 overflow-x-auto bg-[var(--bg-primary)]">
            {hunks
              .filter((h) => h.type !== "added")
              .map((h, idx) => (
                <div
                  key={idx}
                  data-hunk-type={h.type}
                  style={{
                    color: h.type === "removed" ? "var(--accent-red)" : "var(--text-secondary)",
                  }}
                >
                  {h.content}
                </div>
              ))}
          </pre>
          <pre className="font-mono text-xs p-3 m-0 overflow-x-auto bg-[var(--bg-primary)]">
            {hunks
              .filter((h) => h.type !== "removed")
              .map((h, idx) => (
                <div
                  key={idx}
                  data-hunk-type={h.type}
                  style={{
                    color: h.type === "added" ? "var(--accent-green)" : "var(--text-secondary)",
                  }}
                >
                  {h.content}
                </div>
              ))}
          </pre>
        </div>
      )}
    </div>
  );
}

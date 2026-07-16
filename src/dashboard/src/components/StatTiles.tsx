// ══════════════════════════════════════════════════════════════════════
// StatTiles.tsx — 4-column stat grid for ML Leaderboard
// Best AUC · Total Experiments · Best F1 · Min Gap
// ══════════════════════════════════════════════════════════════════════

import type { LeaderboardEntry } from "@shared/dashboard-types";

interface StatTilesProps {
  entries: LeaderboardEntry[];
  bestCvMean: number | null;
  metricName?: string;
}

interface TileData {
  label: string;
  value: string;
  sub: string;
  accent: string;
}

function computeTiles(entries: LeaderboardEntry[], bestCvMean: number | null, metricName: string): TileData[] {
  const valid = entries.filter((e) => e.status !== "FAILED" && e.status !== "OVERFITTED");
  const bestEntry = valid.length > 0
    ? valid.reduce((best, e) => ((e.cvMean ?? -Infinity) > (best.cvMean ?? -Infinity) ? e : best), valid[0])
    : null;

  // Detect active problem type
  const firstWithProblemType = valid.find((e) => e.problemType && e.problemType !== "unknown");
  const activeProblemType = firstWithProblemType?.problemType ?? "classification";

  const algorithms = new Set(valid.map((e) => e.modelAlgorithm ?? e.modelType)).size;
  const minGap = valid.length > 0
    ? Math.min(...valid.map((e) => Math.abs(e.trainValGap ?? 0)))
    : 0;

  const bestAlgo = bestEntry ? (bestEntry.modelAlgorithm ?? bestEntry.modelType) : "";

  if (activeProblemType === "regression") {
    // Regression specific
    const r2Scores = valid
      .map((e) => e.metrics?.regression?.r2Score)
      .filter((v): v is number => v != null);
    const bestR2 = r2Scores.length > 0 ? Math.max(...r2Scores) : null;

    return [
      {
        label: `BEST ${metricName.toUpperCase()}`,
        value: bestCvMean != null ? bestCvMean.toFixed(4) : "—",
        sub: bestAlgo,
        accent: "var(--accent-green)",
      },
      {
        label: "EXPERIMENTS",
        value: String(entries.length),
        sub: `${algorithms} algorithm${algorithms !== 1 ? "s" : ""}`,
        accent: "var(--accent-blue)",
      },
      {
        label: "BEST R²",
        value: bestR2 != null ? bestR2.toFixed(4) : "—",
        sub: "coefficient of det.",
        accent: "var(--accent-blue)",
      },
      {
        label: "MIN OVERFIT Δ",
        value: valid.length > 0 ? minGap.toFixed(4) : "—",
        sub: "overfitting gap",
        accent: minGap < 0.05 ? "var(--accent-green)" : minGap < 0.15 ? "var(--accent-orange)" : "var(--accent-red)",
      },
    ];
  } else {
    // Classification (default)
    const f1Scores = valid
      .map((e) => e.metrics?.classification?.f1)
      .filter((v): v is number => v != null);
    const bestF1 = f1Scores.length > 0 ? Math.max(...f1Scores) : null;

    return [
      {
        label: `BEST ${metricName.toUpperCase()}`,
        value: bestCvMean != null ? bestCvMean.toFixed(4) : "—",
        sub: bestAlgo,
        accent: "var(--accent-green)",
      },
      {
        label: "EXPERIMENTS",
        value: String(entries.length),
        sub: `${algorithms} algorithm${algorithms !== 1 ? "s" : ""}`,
        accent: "var(--accent-blue)",
      },
      {
        label: "BEST F1",
        value: bestF1 != null ? bestF1.toFixed(4) : "—",
        sub: "f1-score metric",
        accent: "var(--accent-blue)",
      },
      {
        label: "MIN OVERFIT Δ",
        value: valid.length > 0 ? minGap.toFixed(4) : "—",
        sub: "overfitting gap",
        accent: minGap < 0.05 ? "var(--accent-green)" : minGap < 0.15 ? "var(--accent-orange)" : "var(--accent-red)",
      },
    ];
  }
}

export function StatTiles({ entries, bestCvMean, metricName = "AUC" }: StatTilesProps) {
  const tiles = computeTiles(entries, bestCvMean, metricName);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-lg bg-[var(--bg-secondary)] p-4 flex flex-col"
        >
          <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
            {t.label}
          </span>
          <span className="text-2xl font-mono font-bold mt-1 tabular-nums" style={{ color: t.accent }}>
            {t.value}
          </span>
          <span className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
            {t.sub}
          </span>
        </div>
      ))}
    </div>
  );
}
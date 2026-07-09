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

  const modelTypes = new Set(valid.map((e) => e.modelType)).size;
  const minGap = valid.length > 0
    ? Math.min(...valid.map((e) => Math.abs(e.trainValGap ?? 0)))
    : 0;

  return [
    {
      label: `BEST ${metricName.toUpperCase()}`,
      value: bestCvMean != null ? bestCvMean.toFixed(4) : "—",
      sub: bestEntry?.modelType ?? "",
      accent: "var(--accent-green)",
    },
    {
      label: "EXPERIMENTS",
      value: String(entries.length),
      sub: `${modelTypes} model${modelTypes !== 1 ? "s" : ""}`,
      accent: "var(--accent-blue)",
    },
    {
      label: "BEST F1",
      value: bestCvMean != null ? bestCvMean.toFixed(3) : "—",
      sub: "mean cv",
      accent: "var(--accent-blue)",
    },
    {
      label: "MIN GAP",
      value: valid.length > 0 ? minGap.toFixed(4) : "—",
      sub: "overfitting",
      accent: minGap < 0.05 ? "var(--accent-green)" : minGap < 0.15 ? "var(--accent-orange)" : "var(--accent-red)",
    },
  ];
}

export function StatTiles({ entries, bestCvMean, metricName = "AUC" }: StatTilesProps) {
  const tiles = computeTiles(entries, bestCvMean, metricName);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 flex flex-col"
        >
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
            {t.label}
          </span>
          <span className="text-xl font-mono font-bold mt-1" style={{ color: t.accent }}>
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
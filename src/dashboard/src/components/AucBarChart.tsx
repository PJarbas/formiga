// ══════════════════════════════════════════════════════════════════════
// AucBarChart.tsx — Horizontal CSS-only bar chart for AUC ranking
// Color by model family, tooltip on hover, animated width transitions
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import type { LeaderboardEntry } from "@shared/dashboard-types";

const MODEL_FAMILY_COLORS: Record<string, string> = {
  xgboost: "#58a6ff",
  lightgbm: "#3fb950",
  catboost: "#d29922",
  randomforest: "#f85149",
  logisticregression: "#a371f7",
  default: "#8b949e",
};

function familyColor(modelType: string): string {
  const key = modelType.toLowerCase().replace(/[^a-z]/g, "");
  for (const k of Object.keys(MODEL_FAMILY_COLORS)) {
    if (key.includes(k)) return MODEL_FAMILY_COLORS[k];
  }
  return MODEL_FAMILY_COLORS.default;
}

interface AucBarChartProps {
  entries: LeaderboardEntry[];
  maxBars?: number;
  metricName?: string;
  metricDirection?: "higher" | "lower";
}

interface BarData {
  id: string;
  label: string;
  auc: number;
  std: number;
  trainAuc: number;
  gap: number;
  hypothesis: string | null;
  modelType: string;
  color: string;
  pct: number;
}

function buildBars(entries: LeaderboardEntry[], maxBars: number, direction: "higher" | "lower" = "higher"): BarData[] {
  const valid = entries
    .filter((e) => e.status !== "FAILED" && e.status !== "OVERFITTED" && e.cvMean != null)
    .sort((a, b) => {
      if (direction === "lower") {
        return (a.cvMean ?? Infinity) - (b.cvMean ?? Infinity);
      }
      return (b.cvMean ?? 0) - (a.cvMean ?? 0);
    })
    .slice(0, maxBars);

  if (valid.length === 0) return [];

  const values = valid.map((e) => e.cvMean ?? 0);
  const maxVal = Math.max(...values);
  const minVal = Math.min(...values);
  const range = maxVal - minVal || 1;

  return valid.map((e, idx) => {
    const val = e.cvMean ?? 0;
    let pct: number;
    if (direction === "lower") {
      pct = ((maxVal - val) / range) * 100;
    } else {
      pct = ((val - minVal) / range) * 100;
    }
    pct = Math.max(10, Math.min(100, pct));

    const isChampion = idx === 0;

    return {
      id: e.id,
      label: e.modelId,
      auc: val,
      std: e.cvStd ?? 0,
      trainAuc: e.trainMean ?? 0,
      gap: e.trainValGap ?? 0,
      hypothesis: e.hypothesis ?? null,
      modelType: e.modelType,
      color: isChampion ? "#58a6ff" : "#4A5568",
      pct,
    };
  });
}

export function AucBarChart({ entries, maxBars = 10, metricName = "AUC", metricDirection = "higher" }: AucBarChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const bars = useMemo(() => buildBars(entries, maxBars, metricDirection), [entries, maxBars, metricDirection]);

  if (bars.length === 0) {
    return (
      <div className="text-xs text-[var(--text-muted)] py-4 text-center">
        No validated experiments yet
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {bars.map((bar) => (
        <div
          key={bar.id}
          className="relative flex items-center gap-3 group"
          onMouseEnter={() => setHovered(bar.id)}
          onMouseLeave={() => setHovered(null)}
        >
          <div className="w-32 md:w-48 text-xs text-[var(--text-secondary)] truncate text-right" title={bar.label}>
            {bar.label}
          </div>
          <div className="flex-1 h-3 bg-[var(--bg-tertiary)] rounded overflow-hidden relative">
            <div
              className="h-full rounded-r transition-[width] duration-500 ease-[cubic-bezier(.4,0,.2,1)]"
              style={{ width: `${bar.pct}%`, backgroundColor: bar.color, opacity: 0.9 }}
            />
          </div>
          <span className="text-xs font-mono text-[var(--text-primary)] w-16 text-right tabular-nums">
            {bar.auc.toFixed(4)}
          </span>

          {/* Tooltip */}
          {hovered === bar.id && (
            <div className="absolute z-10 top-full left-1/2 -translate-x-1/2 mt-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-3 shadow-lg text-xs space-y-1 min-w-[200px]">
              <div className="font-semibold text-[var(--text-primary)]">{bar.modelType}</div>
              <div className="text-[var(--text-secondary)]">{metricName}: {bar.auc.toFixed(4)} ± {bar.std.toFixed(4)}</div>
              <div className="text-[var(--text-secondary)]">Train: {bar.trainAuc.toFixed(4)}</div>
              <div className="text-[var(--text-secondary)]">Gap: {bar.gap.toFixed(4)}</div>
              {bar.hypothesis && (
                <div className="text-[var(--text-muted)] italic border-t border-[var(--border-default)] pt-1 mt-1 truncate" title={bar.hypothesis}>
                  {bar.hypothesis}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
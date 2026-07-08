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

function buildBars(entries: LeaderboardEntry[], maxBars: number): BarData[] {
  const valid = entries
    .filter((e) => e.status !== "FAILED" && e.status !== "OVERFITTED" && e.cvMean != null)
    .sort((a, b) => (b.cvMean ?? 0) - (a.cvMean ?? 0))
    .slice(0, maxBars);

  if (valid.length === 0) return [];

  const maxAuc = valid[0].cvMean ?? 1;
  const minAuc = Math.max(0, (valid[valid.length - 1]?.cvMean ?? 0) - 0.05);

  return valid.map((e) => ({
    id: e.id,
    label: e.modelId,
    auc: e.cvMean ?? 0,
    std: e.cvStd ?? 0,
    trainAuc: e.trainMean ?? 0,
    gap: e.trainValGap ?? 0,
    hypothesis: e.hypothesis ?? null,
    modelType: e.modelType,
    color: familyColor(e.modelType),
    pct: maxAuc > minAuc ? ((e.cvMean ?? 0) - minAuc) / (maxAuc - minAuc) * 100 : 100,
  }));
}

export function AucBarChart({ entries, maxBars = 10 }: AucBarChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const bars = useMemo(() => buildBars(entries, maxBars), [entries, maxBars]);

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
          <div className="flex-1 h-5 bg-[var(--bg-tertiary)] rounded overflow-hidden relative">
            <div
              className="h-full rounded transition-[width] duration-500 ease-[cubic-bezier(.4,0,.2,1)]"
              style={{ width: `${bar.pct}%`, backgroundColor: bar.color, opacity: 0.85 }}
            />
            <span className="absolute right-2 top-0.5 text-xs font-mono text-[var(--text-primary)]">
              {bar.auc.toFixed(4)}
            </span>
          </div>

          {/* Tooltip */}
          {hovered === bar.id && (
            <div className="absolute z-10 top-full left-1/2 -translate-x-1/2 mt-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg p-3 shadow-lg text-xs space-y-1 min-w-[200px]">
              <div className="font-semibold text-[var(--text-primary)]">{bar.modelType}</div>
              <div className="text-[var(--text-secondary)]">AUC: {bar.auc.toFixed(4)} ± {bar.std.toFixed(4)}</div>
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
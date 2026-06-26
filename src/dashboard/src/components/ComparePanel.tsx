// ══════════════════════════════════════════════════════════════════════
// ComparePanel.tsx — Side-by-side comparison of N experiments
// ──────────────────────────────────────────────────────────────────────
// Three sub-sections per spec §5.1: Metrics, Top Features, Hyperparams.
// Marks the winning value per row with a ✓. Scrolls horizontally
// beyond ~4 columns.
// ══════════════════════════════════════════════════════════════════════

import type { LeaderboardEntry } from "@shared/dashboard-types";

export interface ComparePanelProps {
  experiments: LeaderboardEntry[];
}

type MetricRow = {
  label: string;
  /** Read the metric — null when not available. */
  read: (e: LeaderboardEntry) => number | null;
  /** Which direction wins — "max" or "min". */
  better: "max" | "min";
  format: (v: number) => string;
};

const METRIC_ROWS: MetricRow[] = [
  { label: "CV mean", read: (e) => e.cvMean, better: "max", format: (v) => v.toFixed(4) },
  { label: "CV std", read: (e) => e.cvStd, better: "min", format: (v) => v.toFixed(4) },
  { label: "Train mean", read: (e) => e.trainMean, better: "max", format: (v) => v.toFixed(4) },
  { label: "Train/val gap", read: (e) => e.trainValGap, better: "min", format: (v) => v.toFixed(4) },
  {
    label: "Train time (s)",
    read: (e) => e.trainTimeSeconds,
    better: "min",
    format: (v) => v.toFixed(2),
  },
  {
    label: "Inference / 1k (ms)",
    read: (e) => e.inferenceTimeMsPer1k,
    better: "min",
    format: (v) => v.toFixed(2),
  },
];

function pickWinnerIndex(values: Array<number | null>, better: "max" | "min"): number {
  let bestIdx = -1;
  let bestVal: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || Number.isNaN(v)) continue;
    if (bestVal === null || (better === "max" ? v > bestVal : v < bestVal)) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function ComparePanel({ experiments }: ComparePanelProps) {
  if (experiments.length < 2) {
    return (
      <div className="text-sm text-[var(--text-secondary)]" data-testid="compare-empty">
        Select at least two experiments to compare.
      </div>
    );
  }

  // Union of top-feature names across selected experiments (preserves first-seen order)
  const featureOrder: string[] = [];
  const seen = new Set<string>();
  for (const e of experiments) {
    for (const [name] of e.featureImportancesTop10 ?? []) {
      if (!seen.has(name)) {
        seen.add(name);
        featureOrder.push(name);
      }
    }
  }

  // Union of hyperparameter keys
  const hyperOrder: string[] = [];
  const hyperSeen = new Set<string>();
  for (const e of experiments) {
    for (const k of Object.keys(e.hyperparameters ?? {})) {
      if (!hyperSeen.has(k)) {
        hyperSeen.add(k);
        hyperOrder.push(k);
      }
    }
  }

  return (
    <div className="overflow-x-auto" data-testid="compare-panel">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-[var(--text-secondary)]">
            <th className="px-3 py-2 sticky left-0 bg-[var(--bg-primary)]">Field</th>
            {experiments.map((e) => (
              <th key={e.id} className="px-3 py-2 whitespace-nowrap">
                <div className="font-mono text-xs">{e.modelId.slice(0, 12)}</div>
                <div className="text-[var(--text-muted)]">{e.modelType}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={experiments.length + 1} className="px-3 py-2 font-semibold text-[var(--text-primary)]">
              Metrics
            </td>
          </tr>
          {METRIC_ROWS.map((row) => {
            const values = experiments.map(row.read);
            const winnerIdx = pickWinnerIndex(values, row.better);
            return (
              <tr key={row.label} data-row={row.label} className="border-t border-[var(--border-default)]">
                <td className="px-3 py-1.5 text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-primary)]">
                  {row.label}
                </td>
                {values.map((v, i) => (
                  <td
                    key={i}
                    className={`px-3 py-1.5 font-mono ${
                      i === winnerIdx ? "text-[var(--accent-green)]" : "text-[var(--text-primary)]"
                    }`}
                  >
                    {v === null ? "—" : row.format(v)}
                    {i === winnerIdx && <span data-testid="winner-mark" className="ml-1">✓</span>}
                  </td>
                ))}
              </tr>
            );
          })}

          <tr>
            <td colSpan={experiments.length + 1} className="px-3 pt-4 pb-2 font-semibold text-[var(--text-primary)]">
              Top Features
            </td>
          </tr>
          {featureOrder.length === 0 ? (
            <tr>
              <td colSpan={experiments.length + 1} className="px-3 py-1.5 text-[var(--text-muted)] italic">
                No feature importances available.
              </td>
            </tr>
          ) : (
            featureOrder.map((feat) => (
              <tr key={feat} className="border-t border-[var(--border-default)]">
                <td className="px-3 py-1.5 text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-primary)]">
                  {feat}
                </td>
                {experiments.map((e) => {
                  const found = (e.featureImportancesTop10 ?? []).find(([n]) => n === feat);
                  return (
                    <td key={e.id} className="px-3 py-1.5 font-mono text-[var(--text-primary)]">
                      {found ? found[1].toFixed(4) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))
          )}

          <tr>
            <td colSpan={experiments.length + 1} className="px-3 pt-4 pb-2 font-semibold text-[var(--text-primary)]">
              Hyperparameters
            </td>
          </tr>
          {hyperOrder.length === 0 ? (
            <tr>
              <td colSpan={experiments.length + 1} className="px-3 py-1.5 text-[var(--text-muted)] italic">
                No hyperparameters recorded.
              </td>
            </tr>
          ) : (
            hyperOrder.map((key) => (
              <tr key={key} className="border-t border-[var(--border-default)]">
                <td className="px-3 py-1.5 text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-primary)]">
                  {key}
                </td>
                {experiments.map((e) => {
                  const v = (e.hyperparameters ?? {})[key];
                  return (
                    <td key={e.id} className="px-3 py-1.5 font-mono text-[var(--text-primary)]">
                      {v === undefined ? "—" : String(v)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

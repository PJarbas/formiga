// ══════════════════════════════════════════════════════════════════════
// Leaderboard.tsx — ML Leaderboard (v2 redesign)
// StatTiles + AucBarChart + ExperimentsTable + Arena collapsible
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useLeaderboard,
  useArenaSession,
} from "../api/api";
import { ModelDetailPanel } from "../components/ModelDetailPanel";
import { StatTiles } from "../components/StatTiles";
import { AucBarChart } from "../components/AucBarChart";
import { GapPill } from "../components/GapPill";
import { FoldSparkline } from "../components/FoldSparkline";
import type { LeaderboardEntry } from "@shared/dashboard-types";

const MODEL_FAMILY_COLORS: Record<string, string> = {
  xgboost: "#58a6ff",
  lightgbm: "#3fb950",
  catboost: "#d29922",
  randomforest: "#f85149",
  logisticregression: "#a371f7",
  default: "#8b949e",
};

function familyDot(modelType: string): { color: string; family: string } {
  const key = modelType.toLowerCase().replace(/[^a-z]/g, "");
  for (const k of Object.keys(MODEL_FAMILY_COLORS)) {
    if (key.includes(k)) return { color: MODEL_FAMILY_COLORS[k], family: k };
  }
  return { color: MODEL_FAMILY_COLORS.default, family: "other" };
}

type SortKey = "cvMean" | "trainMean" | "trainValGap" | "roundNumber";

export default function Leaderboard() {
  const [searchParams] = useSearchParams();
  const runIdFromUrl = searchParams.get("run") ?? undefined;

  const [sortBy, setSortBy] = useState<SortKey>("cvMean");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [detailEntryId, setDetailEntryId] = useState<string | null>(null);

  const { data, isLoading } = useLeaderboard({
    runId: runIdFromUrl,
    sortBy,
    sortDir,
  });

  // Arena session (for metric name)
  const activeRunId = runIdFromUrl ?? data?.entries?.[0]?.runId;
  const { data: arenaSession } = useArenaSession(activeRunId);

  // Metric configuration from arena session
  const metricName = arenaSession?.metricName ?? "AUC";
  const metricDirection = arenaSession?.metricDirection ?? "higher";


  const sortedEntries = useMemo(() => {
    if (!data?.entries) return [];
    return [...data.entries].sort((a, b) => {
      const aVal = (a[sortBy] as number | null | undefined) ?? 0;
      const bVal = (b[sortBy] as number | null | undefined) ?? 0;
      return sortDir === "desc" ? Number(bVal) - Number(aVal) : Number(aVal) - Number(bVal);
    });
  }, [data, sortBy, sortDir]);

  // Best entry for ranking badge
  const bestId = useMemo(() => {
    let best: LeaderboardEntry | null = null;
    for (const e of sortedEntries) {
      if (e.status === "FAILED" || e.status === "OVERFITTED") continue;
      if (!best || (e.cvMean ?? -Infinity) > (best.cvMean ?? -Infinity)) best = e;
    }
    return best?.id ?? null;
  }, [sortedEntries]);

  const activeProblemType = useMemo(() => {
    const firstWithProblemType = sortedEntries.find((e) => e.problemType && e.problemType !== "unknown");
    return firstWithProblemType?.problemType ?? "classification";
  }, [sortedEntries]);

  const columns = useMemo(() => {
    const base = [
      { key: "modelId", label: "Experiment", sortable: true },
      { key: "modelAlgorithm", label: "Algorithm", sortable: false },
      { key: "problemType", label: "Problem", sortable: false },
      { key: "cvMean", label: `${metricName} CV`, sortable: true, align: "right" as const },
    ];

    if (activeProblemType === "regression") {
      base.push(
        { key: "rmse", label: "RMSE", sortable: false, align: "right" as const },
        { key: "mae", label: "MAE", sortable: false, align: "right" as const },
        { key: "r2Score", label: "R²-Score", sortable: false, align: "right" as const }
      );
    } else {
      base.push(
        { key: "f1_score", label: "F1-Score", sortable: false, align: "right" as const },
        { key: "precision", label: "Precision", sortable: false, align: "right" as const },
        { key: "recall", label: "Recall", sortable: false, align: "right" as const },
        { key: "roc_auc", label: "ROC-AUC", sortable: false, align: "right" as const }
      );
    }

    base.push(
      { key: "cvStd", label: "±Std", sortable: false, align: "right" as const },
      { key: "trainValGap", label: "GAP", sortable: true }
    );

    return base;
  }, [activeProblemType, metricName]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Carregando leaderboard...
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="ml-leaderboard">
      {/* Header with live badge */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
            Leaderboard
            <span className="w-2 h-2 rounded-full bg-[var(--accent-green)] animate-pulse" title="Live — refreshes every 5s" />
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {data?.total ?? 0} experiments · Best: {data?.bestCvMean?.toFixed(4) ?? "—"} · Metric: {metricName} ({metricDirection})
          </p>
        </div>
      </div>

      {/* Stat tiles */}
      <StatTiles entries={sortedEntries} bestCvMean={data?.bestCvMean ?? null} metricName={metricName} />

      {/* Metric bar chart */}
      {sortedEntries.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <h3 className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-medium mb-3">
            {metricName.toUpperCase()} by experiment · validation · cross-validation
          </h3>
          <AucBarChart entries={sortedEntries} maxBars={10} metricName={metricName} metricDirection={metricDirection as "higher" | "lower"} />
        </div>
      )}

      {/* Experiments table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">#</th>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none ${
                      col.sortable ? "cursor-pointer" : ""
                    } ${col.align === "right" ? "text-right" : ""}`}
                    onClick={() => {
                      if (!col.sortable) return;
                      const key = col.key as SortKey;
                      if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else { setSortBy(key); setSortDir("desc"); }
                    }}
                  >
                    {col.label}
                    {col.sortable && sortBy === col.key && (
                      <span className="ml-1 text-[var(--accent-blue)]">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Folds</th>
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 3} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No leaderboard entries yet
                  </td>
                </tr>
              ) : (
                sortedEntries.map((entry, idx) => {
                  const isBest = entry.id === bestId;
                  const isDetail = entry.id === detailEntryId;
                  const algorithm = entry.modelAlgorithm ?? entry.modelType;
                  const { color: dotColor } = familyDot(algorithm);

                  return (
                    <tr
                      key={entry.id}
                      data-testid={`leaderboard-row-${entry.id}`}
                      onClick={() => setDetailEntryId(isDetail ? null : entry.id)}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer ${
                        isDetail ? "border-l-2 border-l-[var(--accent-blue)] bg-[var(--bg-tertiary)]" : ""
                      } ${isBest ? "bg-blue-500/10" : ""}`}
                    >
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">
                        {isBest ? <span className="text-[var(--accent-orange)]">🏆</span> : idx + 1}
                      </td>
                      {columns.map((col) => {
                        if (col.key === "modelId") {
                          return (
                            <td key={col.key} className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                              {entry.modelId}
                              {isBest && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-[var(--accent-green)]/10 text-[var(--accent-green)]">champion</span>}
                            </td>
                          );
                        }

                        if (col.key === "modelAlgorithm") {
                          return (
                            <td key={col.key} className="px-4 py-2.5 text-xs">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
                                {algorithm}
                              </span>
                            </td>
                          );
                        }

                        if (col.key === "problemType") {
                          const type = entry.problemType ?? "unknown";
                          const labels: Record<string, string> = {
                            classification: "Classif.",
                            regression: "Regress.",
                            multilabel: "Multilabel",
                            unknown: "Unknown",
                          };
                          const colors: Record<string, string> = {
                            classification: "bg-blue-500/10 text-blue-400 border-blue-500/20",
                            regression: "bg-purple-500/10 text-purple-400 border-purple-500/20",
                            multilabel: "bg-pink-500/10 text-pink-400 border-pink-500/20",
                            unknown: "bg-gray-500/10 text-gray-400 border-gray-500/20",
                          };
                          return (
                            <td key={col.key} className="px-4 py-2.5 text-xs">
                              <span className={`px-1.5 py-0.5 text-[10px] font-semibold border rounded ${colors[type] ?? colors.unknown}`}>
                                {labels[type] ?? "Unknown"}
                              </span>
                            </td>
                          );
                        }

                        if (col.key === "cvMean") {
                          return (
                            <td key={col.key} className="px-4 py-2.5 font-mono text-xs text-right tabular-nums" style={{ color: isBest ? "var(--accent-green)" : "var(--accent-blue)" }}>
                              {entry.cvMean.toFixed(4)}
                            </td>
                          );
                        }

                        if (col.key === "cvStd") {
                          return (
                            <td key={col.key} className="px-4 py-2.5 font-mono text-xs text-right tabular-nums text-[var(--text-muted)]">
                              {entry.cvStd.toFixed(4)}
                            </td>
                          );
                        }

                        if (col.key === "trainValGap") {
                          return (
                            <td key={col.key} className="px-4 py-2.5">
                              <GapPill gap={entry.trainValGap} />
                            </td>
                          );
                        }

                        // Rich classification metrics
                        if (["f1_score", "precision", "recall", "roc_auc"].includes(col.key)) {
                          const metrics = entry.metrics?.classification;
                          let val: number | undefined;
                          if (col.key === "f1_score") val = metrics?.f1;
                          else if (col.key === "precision") val = metrics?.precision;
                          else if (col.key === "recall") val = metrics?.recall;
                          else if (col.key === "roc_auc") val = metrics?.rocAuc;

                          return (
                            <td key={col.key} className="px-4 py-2.5 font-mono text-xs text-right tabular-nums text-[var(--text-secondary)]">
                              {val != null ? val.toFixed(4) : "—"}
                            </td>
                          );
                        }

                        // Rich regression metrics
                        if (["rmse", "mae", "r2Score"].includes(col.key)) {
                          const metrics = entry.metrics?.regression;
                          let val: number | undefined;
                          if (col.key === "rmse") val = metrics?.rmse;
                          else if (col.key === "mae") val = metrics?.mae;
                          else if (col.key === "r2Score") val = metrics?.r2Score;

                          return (
                            <td key={col.key} className="px-4 py-2.5 font-mono text-xs text-right tabular-nums text-[var(--text-secondary)]">
                              {val != null ? val.toFixed(4) : "—"}
                            </td>
                          );
                        }

                        return <td key={col.key} className="px-4 py-2.5 text-right">—</td>;
                      })}
                      <td className="px-4 py-2.5">
                        <FoldSparkline scores={[]} />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)] max-w-[120px] truncate" title={entry.hypothesis ?? ""}>
                        {entry.hypothesis ?? "·"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Model Detail Panel */}
      {detailEntryId && (() => {
        const detailEntry = sortedEntries.find((e) => e.id === detailEntryId);
        if (!detailEntry) return null;
        return <ModelDetailPanel entry={detailEntry} onClose={() => setDetailEntryId(null)} />;
      })()}

    </div>
  );
}
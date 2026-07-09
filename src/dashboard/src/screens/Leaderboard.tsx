// ══════════════════════════════════════════════════════════════════════
// Leaderboard.tsx — ML Leaderboard (v2 redesign)
// StatTiles + AucBarChart + ExperimentsTable + Arena collapsible
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  useLeaderboard,
  useCompareExperiments,
  useArenaSession,
} from "../api/api";
import { ComparePanel } from "../components/ComparePanel";
import { ModelDetailPanel } from "../components/ModelDetailPanel";
import { ActionBar } from "../components/ActionBar";
import { addToast } from "../components/Toast";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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

  const selectedIdArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const compareQuery = useCompareExperiments(selectedIdArray);

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

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const compareEntries = compareQuery.data?.entries ?? [];
  const panelActions = useMemo(() => [
    { id: "export", label: "Export comparison" },
    { id: "rerun", label: "Re-run with tweaks" },
  ], []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading leaderboard...
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
        <div className="flex items-center gap-3">
          <button
            disabled={selectedIds.size < 2}
            className="text-sm rounded px-3 py-1.5 border border-[var(--border-default)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Compare ({selectedIds.size})
          </button>
          {selectedIds.size > 0 && (
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              Clear
            </button>
          )}
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
          <AucBarChart entries={sortedEntries} maxBars={10} metricName={metricName} />
        </div>
      )}

      {/* Experiments table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left">
                <th className="px-3 py-2.5 w-8" />
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">#</th>
                {([
                  ["modelId", "Experiment"],
                  ["modelType", "Model"],
                  ["roundNumber", "Category"],
                  ["cvMean", `${metricName} CV`],
                  ["cvStd", "±Std"],
                  ["trainValGap", "GAP"],
                ] as [string, string][]).map(([key, label]) => (
                  <th
                    key={key}
                    className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none cursor-pointer"
                    onClick={() => {
                      if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else { setSortBy(key as SortKey); setSortDir("desc"); }
                    }}
                  >
                    {label}
                    {sortBy === key && <span className="ml-1 text-[var(--accent-blue)]">{sortDir === "asc" ? "↑" : "↓"}</span>}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Folds</th>
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No leaderboard entries yet
                  </td>
                </tr>
              ) : (
                sortedEntries.map((entry, idx) => {
                  const isBest = entry.id === bestId;
                  const isDetail = entry.id === detailEntryId;
                  const { color: dotColor } = familyDot(entry.modelType);
                  const statusCategory = entry.status === "FAILED" || entry.status === "OVERFITTED" ? "failed" : entry.status === "AUDITED" ? "audited" : "success";

                  return (
                    <tr
                      key={entry.id}
                      data-testid={`leaderboard-row-${entry.id}`}
                      onClick={() => setDetailEntryId(isDetail ? null : entry.id)}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer ${
                        isDetail ? "border-l-2 border-l-[var(--accent-blue)] bg-[var(--bg-tertiary)]" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleId(entry.id)} />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">
                        {isBest ? <span className="text-[var(--accent-orange)]">🏆</span> : idx + 1}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                        {entry.modelId}
                        {isBest && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-[var(--accent-green)]/10 text-[var(--accent-green)]">champion</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
                          {entry.modelType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">
                        {statusCategory === "failed" ? "FAILED" : statusCategory === "audited" ? "AUDITED" : "MODEL_SEL"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs" style={{ color: isBest ? "var(--accent-green)" : "var(--accent-blue)" }}>
                        {entry.cvMean.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">
                        {entry.cvStd.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5">
                        <GapPill gap={entry.trainValGap} />
                      </td>
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

      {/* Compare Panel */}
      {selectedIds.size >= 2 && (
        <div data-testid="compare-section" className="space-y-3">
          {compareQuery.isLoading ? (
            <div className="text-xs text-[var(--text-muted)]">Loading comparison...</div>
          ) : compareQuery.error ? (
            <div className="text-xs text-[var(--accent-red)]">Compare failed: {(compareQuery.error as Error).message}</div>
          ) : (
            <>
              <ComparePanel experiments={compareEntries} />
              <ActionBar actions={panelActions} onAction={(id) => addToast("info", `"${id}" not yet wired`)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
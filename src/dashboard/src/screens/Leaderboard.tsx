// ══════════════════════════════════════════════════════════════════════
// Leaderboard.tsx — Model Arena (front-specs §5)
// Scatter chart + selectable table + ComparePanel. Best model chosen automatically from leaderboard.
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import ReactECharts from "echarts-for-react";
import {
  useLeaderboard,
  useCompareExperiments,
  useArenaSession,
  useArenaConvergence,
  useArenaConfidence,
  useArenaRounds,
} from "../api/api";
import { ComparePanel } from "../components/ComparePanel";
import { ModelDetailPanel } from "../components/ModelDetailPanel";
import { ActionBar } from "../components/ActionBar";
import { addToast } from "../components/Toast";
import type { LeaderboardEntry } from "@shared/dashboard-types";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

import ArenaControlsBar from "../components/arena/ArenaControlsBar";
import ConvergenceChart from "../components/arena/ConvergenceChart";
import ConfidenceStats from "../components/arena/ConfidenceStats";
import AgentStrategyCards from "../components/arena/AgentStrategyCards";

type SortKey = "cvMean" | "trainMean" | "trainValGap" | "roundNumber";

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

export default function Leaderboard() {
  const [sortBy, setSortBy] = useState<SortKey>("cvMean");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterAgent, setFilterAgent] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailEntryId, setDetailEntryId] = useState<string | null>(null);
  const [chartView, setChartView] = useState<"scatter" | "convergence">("scatter");

  const { data, isLoading } = useLeaderboard({
    agentName: filterAgent || undefined,
    sortBy,
    sortDir,
  });

  // Detect arena run via active runId in first entry
  const activeRunId = data?.entries?.[0]?.runId;
  const { data: arenaSession } = useArenaSession(activeRunId);
  const { data: convergence } = useArenaConvergence(activeRunId);
  const { data: confidence } = useArenaConfidence(activeRunId);
  const { data: rounds } = useArenaRounds(activeRunId);

  const isArenaRun = !!arenaSession;

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

  // Best CV among visible (non-FAILED/OVERFITTED) entries — drives the star.
  const bestId = useMemo(() => {
    let best: LeaderboardEntry | null = null;
    for (const e of sortedEntries) {
      if (e.status === "FAILED" || e.status === "OVERFITTED") continue;
      if (!best || (e.cvMean ?? -Infinity) > (best.cvMean ?? -Infinity)) best = e;
    }
    return best?.id ?? null;
  }, [sortedEntries]);

  const scatterOption = useMemo(() => {
    const entries = sortedEntries;
    // Group by model family for colored buckets.
    const families = new Map<string, { name: string; data: [number, number, string][] }>();
    for (const e of entries) {
      const fam = e.modelType || "unknown";
      if (!families.has(fam)) families.set(fam, { name: fam, data: [] });
      families.get(fam)!.data.push([e.roundNumber, e.cvMean, e.modelId]);
    }
    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item" as const,
        formatter: (p: { value: [number, number, string]; seriesName: string }) =>
          `<b>${p.value[2]}</b><br/>${p.seriesName}<br/>Round ${p.value[0]}<br/>CV: ${p.value[1].toFixed(4)}`,
      },
      legend: { textStyle: { color: "#8b949e" }, top: 0 },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: "value" as const,
        name: "Round",
        nameTextStyle: { color: "#6e7681" },
        axisLabel: { color: "#6e7681", fontSize: 11 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      yAxis: {
        type: "value" as const,
        name: "CV Mean",
        nameTextStyle: { color: "#6e7681" },
        axisLabel: { color: "#6e7681", fontSize: 11 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      series: Array.from(families.values()).map((f) => ({
        name: f.name,
        type: "scatter" as const,
        data: f.data,
        symbolSize: 14,
        itemStyle: { color: familyColor(f.name) },
      })),
    };
  }, [sortedEntries]);

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const compareEntries = compareQuery.data?.entries ?? [];
  const compareWinner = useMemo(() => {
    if (compareEntries.length < 2) return null;
    let best = compareEntries[0];
    for (const e of compareEntries) if ((e.cvMean ?? -Infinity) > (best.cvMean ?? -Infinity)) best = e;
    return best;
  }, [compareEntries]);

  const panelActions = useMemo(() => {
    return [
      { id: "export", label: "Export comparison" },
      { id: "rerun", label: "Re-run with tweaks" },
    ];
  }, []);

  function onPanelAction(id: string) {
    addToast("info", `"${id}" not yet wired`);
  }

  const bestEntry = useMemo(
    () => sortedEntries.find((e) => e.id === bestId) ?? null,
    [sortedEntries, bestId],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading model arena...
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="model-arena">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{isArenaRun ? "Arena" : "Model Arena"}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {data?.total ?? 0} experiments · Best CV: {data?.bestCvMean?.toFixed(4) ?? "—"}
            {isArenaRun && arenaSession?.metricName ? ` · Metric: ${arenaSession.metricName} (${arenaSession.metricDirection})` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            data-testid="compare-btn"
            disabled={selectedIds.size < 2}
            onClick={() => {
              /* no-op: ComparePanel is reactive to selectedIds */
            }}
            className="text-sm rounded px-3 py-1.5 border border-[var(--border-default)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Compare selected ({selectedIds.size})
          </button>
          {selectedIds.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Clear
            </button>
          )}
          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded px-3 py-1.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
          >
            <option value="">All agents</option>
            <option value="modeler-classic">Modeler Classic</option>
            <option value="modeler-advanced">Modeler Advanced</option>
          </select>
        </div>
      </div>

      {/* Arena controls */}
      {isArenaRun && arenaSession && (
        <ArenaControlsBar runId={arenaSession.runId} status={arenaSession.status} />
      )}

      {/* Best Model Banner */}
      {bestEntry && data?.bestCvMean != null && (
        <div className="bg-[var(--accent-green)]/10 border border-[var(--accent-green)]/30 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl" aria-hidden="true">🏆</span>
            <div>
              <h3 className="font-semibold text-[var(--accent-green)]">Best Model</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                <span className="font-mono text-[var(--accent-blue)]">{data.bestCvMean.toFixed(4)}</span>
                {" · "}{bestEntry.modelType}
                {" · Round "}{bestEntry.roundNumber}
              </p>
            </div>
          </div>
          <Link to="/kanban" className="text-sm text-[var(--accent-blue)] hover:underline">
            {AGENT_INFO_REGISTRY[bestEntry.agentName]?.label ?? bestEntry.agentName} · Experiment Board →
          </Link>
        </div>
      )}

      {/* Confidence stats */}
      {isArenaRun && (
        <ConfidenceStats confidence={confidence} session={arenaSession} />
      )}

      {/* Chart toggle */}
      {isArenaRun && (
        <div className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-1 py-0.5 w-fit">
          <button
            type="button"
            onClick={() => setChartView("scatter")}
            className={`text-xs px-2 py-0.5 rounded ${chartView === "scatter" ? "bg-[var(--accent-blue)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
          >
            Scatter
          </button>
          <button
            type="button"
            onClick={() => setChartView("convergence")}
            className={`text-xs px-2 py-0.5 rounded ${chartView === "convergence" ? "bg-[var(--accent-blue)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
          >
            Convergence
          </button>
        </div>
      )}

      {/* Chart */}
      {sortedEntries.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          {isArenaRun && chartView === "convergence" ? (
            <ConvergenceChart
              points={convergence?.points ?? []}
              confidence={confidence}
              maxRounds={arenaSession?.maxRounds ?? 5}
            />
          ) : (
            <ReactECharts option={scatterOption} style={{ height: 320 }} notMerge />
          )}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left">
                <th className="px-3 py-2.5 w-8" />
                {([
                  ["modelId", "Model"],
                  ["agentName", "Agent"],
                  ["modelType", "Type"],
                  ["roundNumber", "Round"],
                  ["cvMean", "CV Mean"],
                  ["cvStd", "CV Std"],
                  ["trainMean", "Train"],
                  ["trainValGap", "Gap"],
                ] as const).map(([key, label]) => (
                  <th
                    key={key}
                    className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none"
                    onClick={() => {
                      if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else {
                        setSortBy(key as SortKey);
                        setSortDir("desc");
                      }
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    {label}
                    {sortBy === key && (
                      <span className="ml-1 text-[var(--accent-blue)]">
                        {sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </th>
                ))}
                {/* Arena extra columns */}
                {isArenaRun && (
                  <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none">
                    Decision
                  </th>
                )}
                <th className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none">
                  Audit
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={isArenaRun ? 10 : 9} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No leaderboard entries yet
                  </td>
                </tr>
              ) : (
                sortedEntries.map((entry) => {
                  const isSelected = selectedIds.has(entry.id);
                  const isBest = entry.id === bestId;
                  const isDetail = entry.id === detailEntryId;
                  return (
                    <tr
                      key={entry.id}
                      data-testid={`arena-row-${entry.id}`}
                      data-selected={isSelected ? "true" : "false"}
                      onClick={() => setDetailEntryId(isDetail ? null : entry.id)}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer ${
                        isDetail ? "border-l-2 border-l-[var(--accent-blue)] bg-[var(--bg-tertiary)]" : ""
                      }`}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          data-testid={`arena-select-${entry.id}`}
                          checked={isSelected}
                          onChange={() => toggleId(entry.id)}
                        />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                        {isBest && <span className="mr-1 text-[var(--accent-orange)]">★</span>}
                        {entry.modelId}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)] text-xs">{entry.agentName}</td>
                      <td className="px-4 py-2.5 text-[var(--text-primary)] text-xs">{entry.modelType}</td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)] text-xs">{entry.roundNumber}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--accent-blue)]">
                        {entry.cvMean.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">
                        {entry.cvStd.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">
                        {entry.trainMean.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-[var(--accent-orange)]">
                        {entry.trainValGap.toFixed(4)}
                      </td>
                      {/* Arena Decision cell */}
                      {isArenaRun && (
                        <td className="px-4 py-2.5">
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded ${
                              entry.decision?.toLowerCase() === "keep"
                                ? "bg-[var(--accent-green)]/10 text-[var(--accent-green)]"
                                : entry.decision?.toLowerCase() === "discard"
                                  ? "bg-[var(--status-idle)]/10 text-[var(--text-muted)]"
                                  : "bg-[var(--status-failed)]/10 text-[var(--status-failed)]"
                            }`}
                          >
                            {entry.decision?.toUpperCase() ?? "·"}
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2.5">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${
                            entry.status === "AUDITED"
                              ? "bg-[var(--accent-green)]/10 text-[var(--accent-green)]"
                              : entry.status === "FAILED" || entry.status === "OVERFITTED"
                                ? "bg-[var(--accent-red)]/10 text-[var(--accent-red)]"
                                : "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                          }`}
                          title={entry.status}
                        >
                          {entry.status === "AUDITED" ? "✓" : entry.status === "FAILED" ? "✗" : entry.status === "OVERFITTED" ? "⚠" : "·"}
                        </span>
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
        return (
          <ModelDetailPanel
            entry={detailEntry}
            onClose={() => setDetailEntryId(null)}
          />
        );
      })()}

      {/* ComparePanel */}
      {selectedIds.size >= 2 && (
        <div data-testid="compare-section" className="space-y-3">
          {compareQuery.isLoading ? (
            <div className="text-xs text-[var(--text-muted)]">Loading comparison…</div>
          ) : compareQuery.error ? (
            <div className="text-xs text-[var(--accent-red)]">
              Compare failed: {(compareQuery.error as Error).message}
            </div>
          ) : (
            <>
              <ComparePanel experiments={compareEntries} />
              <ActionBar actions={panelActions} onAction={onPanelAction} />
            </>
          )}
        </div>
      )}

      {/* Arena strategies */}
      {isArenaRun && (
        <AgentStrategyCards rounds={rounds ?? []} />
      )}
    </div>
  );
}

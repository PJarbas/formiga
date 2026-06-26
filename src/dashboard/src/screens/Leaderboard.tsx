// ══════════════════════════════════════════════════════════════════════
// Leaderboard.tsx — Model Arena (front-specs §5)
// Scatter chart + selectable table + ComparePanel + promote/reject.
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import ReactECharts from "echarts-for-react";
import {
  useLeaderboard,
  useCompareExperiments,
  useExperimentActions,
} from "../api/api";
import { ComparePanel } from "../components/ComparePanel";
import { ActionBar } from "../components/ActionBar";
import type { Action, LeaderboardEntry } from "@shared/dashboard-types";

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
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const { data, isLoading } = useLeaderboard({
    agentName: filterAgent || undefined,
    sortBy,
    sortDir,
  });
  const { promote, reject } = useExperimentActions();

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

  // Best CV among the visible (non-rejected) entries — drives the ⭐.
  const bestId = useMemo(() => {
    let best: LeaderboardEntry | null = null;
    for (const e of sortedEntries) {
      if (e.rejectedAt) continue;
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
        symbolSize: 14, // TODO: scale by train_time_seconds when available
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

  function handlePromote(id: string) {
    setActionMsg(null);
    promote.mutate(id, {
      onSuccess: () => setActionMsg(`Promoted ${id}`),
      onError: (err) => setActionMsg(`Promote failed: ${(err as Error).message}`),
    });
  }

  function handleReject(id: string) {
    setActionMsg(null);
    const reason = window.prompt("Reject reason (optional):") ?? undefined;
    reject.mutate(
      { id, reason },
      {
        onSuccess: () => setActionMsg(`Rejected ${id}`),
        onError: (err) => setActionMsg(`Reject failed: ${(err as Error).message}`),
      },
    );
  }

  const panelActions: Action[] = useMemo(() => {
    const acts: Action[] = [];
    if (compareWinner) {
      acts.push({ id: "promote-winner", label: `Promote ${compareWinner.modelId}`, primary: true, variant: "success" });
    }
    acts.push({ id: "export", label: "Export comparison" });
    acts.push({ id: "rerun", label: "Re-run with tweaks" });
    return acts;
  }, [compareWinner]);

  function onPanelAction(id: string) {
    if (id === "promote-winner" && compareWinner) {
      handlePromote(compareWinner.id);
      return;
    }
    // Stubbed for spec parity (front-specs §5.1)
    setActionMsg(`"${id}" not yet wired`);
  }

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
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Model Arena</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {data?.total ?? 0} experiments · Best CV: {data?.bestCvMean?.toFixed(4) ?? "—"}
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

      {actionMsg && (
        <div
          data-testid="arena-toast"
          className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded px-3 py-1.5"
        >
          {actionMsg}
        </div>
      )}

      {/* Scatter */}
      {sortedEntries.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <ReactECharts option={scatterOption} style={{ height: 320 }} notMerge />
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
                  ["actions", "Actions"],
                ] as const).map(([key, label]) => (
                  <th
                    key={key}
                    className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide select-none"
                    onClick={() => {
                      if (key === "actions") return;
                      if (sortBy === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      else {
                        setSortBy(key as SortKey);
                        setSortDir("desc");
                      }
                    }}
                    style={{ cursor: key === "actions" ? "default" : "pointer" }}
                  >
                    {label}
                    {sortBy === key && (
                      <span className="ml-1 text-[var(--accent-blue)]">
                        {sortDir === "asc" ? "\u2191" : "\u2193"}
                      </span>
                    )}
                  </th>
                ))}
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
                sortedEntries.map((entry) => {
                  const isSelected = selectedIds.has(entry.id);
                  const isBest = entry.id === bestId;
                  const isRejected = !!entry.rejectedAt;
                  const isPromoted = !!entry.promotedAt;
                  return (
                    <tr
                      key={entry.id}
                      data-testid={`arena-row-${entry.id}`}
                      data-selected={isSelected ? "true" : "false"}
                      data-rejected={isRejected ? "true" : "false"}
                      data-promoted={isPromoted ? "true" : "false"}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] transition-colors ${
                        isRejected ? "opacity-50" : ""
                      }`}
                      style={
                        isPromoted
                          ? { borderLeft: "3px solid var(--accent-green)" }
                          : undefined
                      }
                    >
                      <td className="px-3 py-2.5">
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
                      <td className="px-4 py-2.5">
                        <div className="flex gap-2 text-xs">
                          {!isPromoted && (
                            <button
                              data-testid={`promote-${entry.id}`}
                              className="text-[var(--accent-green)] hover:underline"
                              onClick={() => handlePromote(entry.id)}
                            >
                              Promote
                            </button>
                          )}
                          {!isRejected && (
                            <button
                              data-testid={`reject-${entry.id}`}
                              className="text-[var(--accent-red)] hover:underline"
                              onClick={() => handleReject(entry.id)}
                            >
                              Reject
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

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
    </div>
  );
}

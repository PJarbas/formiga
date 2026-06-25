// ══════════════════════════════════════════════════════════════════════
// Leaderboard.tsx — Tela 3: sortable table + ECharts cv_mean evolution
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { useLeaderboard } from "../api/api";
import ReactECharts from "echarts-for-react";
import type { LeaderboardEntry } from "@shared/dashboard-types";

type SortKey = "cvMean" | "trainMean" | "trainValGap" | "roundNumber";

export default function Leaderboard() {
  const [sortBy, setSortBy] = useState<SortKey>("cvMean");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterAgent, setFilterAgent] = useState<string>("");

  const { data, isLoading } = useLeaderboard({
    agentName: filterAgent || undefined,
    sortBy,
    sortDir,
  });

  const sortedEntries = useMemo(() => {
    if (!data?.entries) return [];
    return [...data.entries].sort((a, b) => {
      const aVal = a[sortBy] ?? 0;
      const bVal = b[sortBy] ?? 0;
      return sortDir === "desc" ? Number(bVal) - Number(aVal) : Number(aVal) - Number(bVal);
    });
  }, [data, sortBy, sortDir]);

  const chartOption = useMemo(() => {
    const entries = data?.entries ?? [];
    return {
      backgroundColor: "transparent",
      tooltip: { trigger: "axis" as const },
      legend: { data: ["CV Mean", "Train Mean"], textStyle: { color: "#8b949e" } },
      grid: { left: 50, right: 20, top: 30, bottom: 40 },
      xAxis: {
        type: "category" as const,
        data: entries.map((_, i) => `#${i + 1}`),
        axisLabel: { color: "#6e7681", fontSize: 11 },
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { color: "#6e7681", fontSize: 11 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      series: [
        {
          name: "CV Mean",
          type: "line",
          data: entries.map((e) => e.cvMean),
          smooth: true,
          lineStyle: { color: "#58a6ff", width: 2 },
          itemStyle: { color: "#58a6ff" },
          symbol: "circle",
          symbolSize: 6,
        },
        {
          name: "Train Mean",
          type: "line",
          data: entries.map((e) => e.trainMean),
          smooth: true,
          lineStyle: { color: "#3fb950", width: 2 },
          itemStyle: { color: "#3fb950" },
          symbol: "diamond",
          symbolSize: 6,
        },
      ],
    };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading leaderboard...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Leaderboard</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {data?.total ?? 0} experiments · Best CV: {data?.bestCvMean?.toFixed(4) ?? "—"}
          </p>
        </div>
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

      {/* Chart */}
      {sortedEntries.length > 0 && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <ReactECharts option={chartOption} style={{ height: 280 }} notMerge />
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left">
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
                    className="px-4 py-2.5 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide cursor-pointer hover:text-[var(--text-primary)] select-none"
                    onClick={() => {
                      if (sortBy === key) {
                        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                      } else {
                        setSortBy(key as SortKey);
                        setSortDir("desc");
                      }
                    }}
                  >
                    {label}
                    {sortBy === key && (
                      <span className="ml-1 text-[var(--accent-blue)]">{sortDir === "asc" ? "\u2191" : "\u2193"}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedEntries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-[var(--text-muted)]">
                    No leaderboard entries yet
                  </td>
                </tr>
              ) : (
                sortedEntries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-primary)]">{entry.modelId}</td>
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { ConvergencePoint, ArenaConfidenceResponse } from "@shared/dashboard-types";

interface ConvergenceChartProps {
  points: ConvergencePoint[];
  confidence: ArenaConfidenceResponse | undefined;
  maxRounds: number;
}

export default function ConvergenceChart({ points, confidence, maxRounds }: ConvergenceChartProps) {
  const option = useMemo(() => {
    const xTicks = Array.from({ length: maxRounds }, (_, i) => i + 1);

    // Group points per round per agent
    const agentSeries = new Map<string, { data: [number, number][] }>();
    for (const p of points) {
      if (!agentSeries.has(p.agent)) agentSeries.set(p.agent, { data: [] });
      agentSeries.get(p.agent)!.data.push([p.round, p.metric]);
    }

    const series: any[] = [];
    for (const [agent, s] of agentSeries) {
      series.push({
        name: agent,
        type: "line",
        data: s.data.sort((a, b) => a[0] - b[0]),
        smooth: true,
        symbolSize: 8,
        lineStyle: { width: 2 },
      });
    }

    // Target line
    if (confidence?.bestMetric != null) {
      series.push({
        name: "Best",
        type: "line",
        data: [[1, confidence.bestMetric], [maxRounds, confidence.bestMetric]],
        lineStyle: { type: "dashed", width: 1, color: "#3fb950" },
        symbol: "none",
        silent: true,
      });
    }

    // Noise floor line
    if (confidence?.noiseFloorMad != null && confidence.bestMetric != null) {
      // Place noise floor as a horizontal line offset by MAD below best
      const floor = confidence.bestMetric - (confidence.noiseFloorMad ?? 0);
      series.push({
        name: "Noise Floor",
        type: "line",
        data: [[1, floor], [maxRounds, floor]],
        lineStyle: { type: "dotted", width: 1, color: "#d29922" },
        symbol: "none",
        silent: true,
      });
    }

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis" as const,
        axisPointer: { type: "cross" as const },
      },
      legend: { textStyle: { color: "#8b949e" }, top: 0 },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: "value" as const,
        min: 1,
        max: maxRounds,
        interval: 1,
        name: "Round",
        nameTextStyle: { color: "#6e7681" },
        axisLabel: { color: "#6e7681", fontSize: 11 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      yAxis: {
        type: "value" as const,
        name: "Metric",
        nameTextStyle: { color: "#6e7681" },
        axisLabel: { color: "#6e7681", fontSize: 11 },
        splitLine: { lineStyle: { color: "#21262d" } },
      },
      series,
    };
  }, [points, confidence, maxRounds]);

  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6 text-center text-sm text-[var(--text-muted)]">
        No convergence data yet. Results will appear after the first round completes.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-[var(--text-primary)]">Convergence</span>
        {confidence?.bestMetric != null && (
          <span className="text-xs text-[var(--text-muted)]">
            Best: {confidence.bestMetric.toFixed(4)} &middot; {confidence.bestAgent ?? "—"}
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 320 }} notMerge />
    </div>
  );
}

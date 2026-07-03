import type { ArenaConfidenceResponse, ArenaSessionResponse } from "@shared/dashboard-types";
import { getStatusConfig } from "../../lib/status-config";

interface ConfidenceStatsProps {
  confidence: ArenaConfidenceResponse | undefined;
  session: ArenaSessionResponse | undefined;
}

export default function ConfidenceStats({ confidence, session }: ConfidenceStatsProps) {
  if (!confidence || !session) return null;

  const band =
    confidence.bestMetric == null || confidence.noiseFloorMad == null
      ? "unknown"
      : confidence.bestMetric >= (confidence.noiseFloorMad != null ? confidence.noiseFloorMad * 2 : 0)
        ? "high"
        : confidence.bestMetric >= (confidence.noiseFloorMad != null ? confidence.noiseFloorMad : 0)
          ? "medium"
          : "low";

  const bandConfig = getStatusConfig(band === "high" ? "success" : band === "medium" ? "running" : "failed");

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Best Metric</div>
        <div className="text-lg font-mono font-semibold text-[var(--text-primary)] mt-1">
          {confidence.bestMetric?.toFixed(4) ?? "—"}
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Best Agent</div>
        <div className="text-sm font-medium text-[var(--text-primary)] mt-1">
          {confidence.bestAgent ?? "—"}
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Noise Floor (MAD)</div>
        <div className="text-lg font-mono font-semibold text-[var(--text-primary)] mt-1">
          {confidence.noiseFloorMad?.toFixed(4) ?? "—"}
        </div>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3">
        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Confidence</div>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${bandConfig.bgClass} ${bandConfig.borderClass} border`}>
            {bandConfig.emoji} {band.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}

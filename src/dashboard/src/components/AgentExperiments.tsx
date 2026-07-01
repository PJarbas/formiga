import { useMemo } from "react";
import { useLeaderboard } from "../api/api";
import { Sparkline } from "./Sparkline";

interface Props {
  agentName: string;
}

function statusBadge(status: string) {
  if (status === "AUDITED") return { label: "✓", cls: "bg-[var(--accent-green)]/10 text-[var(--accent-green)]" };
  if (status === "SUCCESS") return { label: "✓", cls: "bg-[var(--accent-blue)]/10 text-[var(--accent-blue)]" };
  if (status === "OVERFITTED") return { label: "⚠", cls: "bg-[var(--accent-orange)]/10 text-[var(--accent-orange)]" };
  if (status === "FAILED") return { label: "✗", cls: "bg-[var(--accent-red)]/10 text-[var(--accent-red)]" };
  return { label: "·", cls: "bg-[var(--bg-tertiary)] text-[var(--text-muted)]" };
}

export function AgentExperiments({ agentName }: Props) {
  const { data, isLoading } = useLeaderboard({
    agentName,
    sortBy: "roundNumber",
    sortDir: "desc",
  });

  const entries = data?.entries ?? [];

  const sparklineData = useMemo(() => {
    if (entries.length < 2) return [];
    return [...entries].sort((a, b) => a.roundNumber - b.roundNumber).map((e) => e.cvMean);
  }, [entries]);

  if (isLoading) {
    return <p className="text-xs text-[var(--text-muted)] py-4 text-center">Loading experiments...</p>;
  }

  if (entries.length === 0) {
    return <p className="text-xs text-[var(--text-muted)] italic py-4 text-center">No experiments registered yet.</p>;
  }

  return (
    <div className="space-y-3">
      {sparklineData.length >= 2 && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--text-muted)]">CV Mean trend:</span>
          <Sparkline data={sparklineData} width={160} height={28} />
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border-default)] text-left">
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Round</th>
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Model</th>
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">CV Mean</th>
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Gap</th>
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
              <th className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Reason</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 10).map((e) => {
              const badge = statusBadge(e.status);
              return (
                <tr key={e.id} className="border-b border-[var(--border-default)]">
                  <td className="px-3 py-2 text-xs text-[var(--text-primary)]">R{e.roundNumber}</td>
                  <td className="px-3 py-2 text-xs text-[var(--text-primary)] font-medium">{e.modelType}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--accent-blue)]">{e.cvMean.toFixed(4)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--accent-orange)]">{e.trainValGap.toFixed(4)}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--text-muted)] truncate max-w-[150px]" title={e.rejectReason ?? ""}>
                    {e.rejectReason ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {entries.length > 10 && (
        <p className="text-[10px] text-[var(--text-muted)] text-center">
          Showing 10 of {entries.length} experiments
        </p>
      )}
    </div>
  );
}

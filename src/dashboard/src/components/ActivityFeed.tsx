// ══════════════════════════════════════════════════════════════════════
// ActivityFeed.tsx — Client-side merged logs from running agent
// ══════════════════════════════════════════════════════════════════════
// No new backend endpoint — reuses existing useAgentLogs hook.
// Shows last 20 entries from the currently-running agent.
// Auto-scrolls via overflow-y-auto. Uses formatTime from lib.
// ══════════════════════════════════════════════════════════════════════

import { useAgentLogs, useCommandCenter } from "../api/api.js";
import { formatTime } from "../lib/format.js";

export function ActivityFeed() {
  const { data: cc } = useCommandCenter();
  const runningAgent = cc?.agentStrip.find((a) => a.status === "running");

  // Only fetch logs for the currently-running agent
  const { data: logs } = useAgentLogs(runningAgent?.name, 0, 20);

  if (!logs || logs.entries.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Recent Activity</h3>
        <p className="text-xs text-[var(--text-muted)]">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Recent Activity</h3>
      <div className="max-h-[200px] overflow-y-auto space-y-1">
        {logs.entries.slice(-20).map((entry, i) => (
          <div
            key={i}
            className={`flex gap-2 text-xs py-0.5 ${
              entry.level === "error"
                ? "text-[var(--accent-red)]"
                : entry.level === "warn"
                  ? "text-[var(--accent-orange)]"
                  : "text-[var(--text-secondary)]"
            }`}
          >
            <span className="text-[var(--text-muted)] font-mono shrink-0">{formatTime(entry.timestamp)}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
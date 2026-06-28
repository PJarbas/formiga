// ══════════════════════════════════════════════════════════════════════
// StatusCard.tsx — Hero status card for CommandCenter
// ══════════════════════════════════════════════════════════════════════
// Pure presentational — all data from props. Derivation happens in
// useHumanStatus() hook. No logic, no side effects.
// ══════════════════════════════════════════════════════════════════════

import type { HumanStatus } from "../lib/human-status.js";
import { formatElapsedBetween } from "../lib/format.js";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

export interface StatusCardProps {
  status: HumanStatus;
  /** ISO timestamps for elapsed calculation */
  startedAt: string | null;
  updatedAt: string | null;
  /** Name of the currently-running agent (if any) */
  currentAgent?: string;
}

export function StatusCard({ status, startedAt, updatedAt, currentAgent }: StatusCardProps) {
  const agentInfo = currentAgent ? AGENT_INFO_REGISTRY[currentAgent] : undefined;
  const elapsed = formatElapsedBetween(startedAt, updatedAt);
  const colorStyle = `var(${status.colorVar})`;

  return (
    <div
      data-testid="status-card"
      className={`rounded-lg border-l-4 p-6 ${status.isUrgent ? "animate-pulse-subtle" : ""}`}
      style={{
        borderColor: colorStyle,
        backgroundColor: `color-mix(in srgb, ${colorStyle} 8%, transparent)`,
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl" aria-hidden="true">{status.emoji}</span>
          <div>
            <h2 className="text-2xl font-bold" style={{ color: colorStyle }}>
              {status.description}
            </h2>
            {agentInfo && (
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Agent: {agentInfo.label}
              </p>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--text-muted)]">Elapsed</p>
          <p className="text-2xl font-mono text-[var(--text-primary)]">{elapsed}</p>
        </div>
      </div>
    </div>
  );
}
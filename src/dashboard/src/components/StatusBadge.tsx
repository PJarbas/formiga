// ══════════════════════════════════════════════════════════════════════
// StatusBadge.tsx — Visual badge for experiment/spec/agent status states
// ──────────────────────────────────────────────────────────────────────
// Wraps the base AgentStatus + ExperimentStatus values plus the extended
// promoted/rejected decision states. Pure presentational.
// ══════════════════════════════════════════════════════════════════════

import type { AgentStatus } from "@shared/dashboard-types";

export type BadgeStatus =
  | AgentStatus
  | "pending"
  | "approved"
  | "rejected"
  | "promoted"
  | "overfitted"
  | "success";

export interface StatusBadgeProps {
  status: BadgeStatus;
  label?: string;
  size?: "sm" | "md" | "lg";
}

const STATUS_TO_COLOR: Record<BadgeStatus, string> = {
  idle: "var(--text-muted)",
  running: "var(--accent-blue)",
  completed: "var(--accent-green)",
  failed: "var(--accent-red)",
  timed_out: "var(--accent-orange)",
  pending: "var(--accent-orange)",
  approved: "var(--accent-green)",
  rejected: "var(--accent-red)",
  promoted: "var(--accent-green)",
  overfitted: "var(--accent-orange)",
  success: "var(--accent-green)",
};

const SIZE_CLASSES: Record<NonNullable<StatusBadgeProps["size"]>, string> = {
  sm: "text-xs px-1.5 py-0.5",
  md: "text-sm px-2 py-0.5",
  lg: "text-base px-3 py-1",
};

export function StatusBadge({ status, label, size = "md" }: StatusBadgeProps) {
  const color = STATUS_TO_COLOR[status] ?? "var(--text-muted)";
  const sizeClass = SIZE_CLASSES[size];
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full font-medium border ${sizeClass}`}
      style={{ borderColor: color, color }}
    >
      <span
        aria-hidden="true"
        className="inline-block rounded-full"
        style={{ width: 8, height: 8, background: color }}
      />
      <span className="capitalize">{label ?? status.replace(/_/g, " ")}</span>
    </span>
  );
}

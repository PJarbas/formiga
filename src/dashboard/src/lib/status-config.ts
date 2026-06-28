// ══════════════════════════════════════════════════════════════════════
// status-config.ts — Single source of truth for all status display metadata
// ══════════════════════════════════════════════════════════════════════
// Every status in the system has exactly one entry here. Components
// NEVER hardcode emoji, colors, or labels — they consume STATUS_CONFIG.
// ══════════════════════════════════════════════════════════════════════

import type { AgentStatus, BadgeStatus } from "@shared/dashboard-types";

/** Union of all UI-visible status keys */
export type UIStatus = AgentStatus | Exclude<BadgeStatus, AgentStatus>;

export interface StatusConfig {
  /** Machine-readable key — matches backend status value */
  key: UIStatus;
  /** Display label — human-friendly, uppercase */
  label: string;
  /** Emoji for icon representation */
  emoji: string;
  /** CSS variable name for color (without var() wrapper) */
  colorVar: string;
  /** Hex fallback — used where CSS vars aren't available (e.g. ECharts) */
  hex: string;
  /** Tailwind classes for the status dot */
  dotClass: string;
  /** Tailwind classes for the card/badge border */
  borderClass: string;
  /** Tailwind classes for background tint (5-10% opacity) */
  bgClass: string;
  /** Visual weight — used for ordering and prominence */
  priority: number;
  /** Whether this status demands immediate user attention */
  isUrgent: boolean;
}

// ── Every status in the system — single source of truth ────────────
export const STATUS_CONFIG: Record<UIStatus, StatusConfig> = {
  idle: {
    key: "idle",
    label: "PENDING",
    emoji: "⚪",
    colorVar: "--status-idle",
    hex: "#6e7681",
    dotClass: "bg-[var(--status-idle)]",
    borderClass: "border-[var(--status-idle)]",
    bgClass: "bg-[var(--status-idle)]/5",
    priority: 0,
    isUrgent: false,
  },
  pending: {
    key: "pending",
    label: "PENDING",
    emoji: "⚪",
    colorVar: "--status-pending",
    hex: "#6e7681",
    dotClass: "bg-[var(--status-pending)]",
    borderClass: "border-[var(--status-pending)]",
    bgClass: "bg-[var(--status-pending)]/5",
    priority: 0,
    isUrgent: false,
  },
  running: {
    key: "running",
    label: "RUNNING",
    emoji: "🔵",
    colorVar: "--status-running",
    hex: "#0969da",
    dotClass: "bg-[var(--status-running)]",
    borderClass: "border-[var(--status-running)]",
    bgClass: "bg-[var(--status-running)]/10",
    priority: 1,
    isUrgent: false,
  },
  completed: {
    key: "completed",
    label: "DONE",
    emoji: "✅",
    colorVar: "--status-completed",
    hex: "#1a7f37",
    dotClass: "bg-[var(--status-completed)]",
    borderClass: "border-[var(--status-completed)]",
    bgClass: "bg-[var(--status-completed)]/5",
    priority: 2,
    isUrgent: false,
  },
  failed: {
    key: "failed",
    label: "FAILED",
    emoji: "❌",
    colorVar: "--status-failed",
    hex: "#da3633",
    dotClass: "bg-[var(--status-failed)]",
    borderClass: "border-[var(--status-failed)]",
    bgClass: "bg-[var(--status-failed)]/10",
    priority: 3,
    isUrgent: true,
  },
  timed_out: {
    key: "timed_out",
    label: "TIMED OUT",
    emoji: "⏱️",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 3,
    isUrgent: true,
  },
  approved: {
    key: "approved",
    label: "APPROVED",
    emoji: "✅",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  rejected: {
    key: "rejected",
    label: "REJECTED",
    emoji: "🚫",
    colorVar: "--accent-red",
    hex: "#f85149",
    dotClass: "bg-[var(--accent-red)]",
    borderClass: "border-[var(--accent-red)]",
    bgClass: "bg-[var(--accent-red)]/5",
    priority: 3,
    isUrgent: true,
  },
  promoted: {
    key: "promoted",
    label: "PROMOTED",
    emoji: "⬆️",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  overfitted: {
    key: "overfitted",
    label: "OVERFITTED",
    emoji: "⚠️",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 3,
    isUrgent: true,
  },
  success: {
    key: "success",
    label: "SUCCESS",
    emoji: "✅",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
};

/** Lookup with fallback — unknown statuses map to idle config */
export function getStatusConfig(status: string): StatusConfig {
  return (STATUS_CONFIG as Record<string, StatusConfig>)[status] ?? STATUS_CONFIG.idle;
}
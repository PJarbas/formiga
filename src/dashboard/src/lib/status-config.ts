import type { AgentStatus } from "@shared/dashboard-types";

export type UIStatus =
  | AgentStatus
  | "pending"
  | "approved"
  | "rejected"
  | "promoted"
  | "overfitted"
  | "success"
  | "keep"
  | "discard"
  | "crash"
  | "converged"
  | "target_reached"
  | "max_rounds"
  | "max_no_improve"
  | "paused";

export interface StatusConfig {
  key: UIStatus;
  label: string;
  emoji: string;
  colorVar: string;
  hex: string;
  dotClass: string;
  borderClass: string;
  bgClass: string;
  priority: number;
  isUrgent: boolean;
}

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
  keep: {
    key: "keep",
    label: "KEPT",
    emoji: "✅",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  discard: {
    key: "discard",
    label: "DISCARDED",
    emoji: "🗑️",
    colorVar: "--status-idle",
    hex: "#6e7681",
    dotClass: "bg-[var(--status-idle)]",
    borderClass: "border-[var(--status-idle)]",
    bgClass: "bg-[var(--status-idle)]/5",
    priority: 0,
    isUrgent: false,
  },
  crash: {
    key: "crash",
    label: "CRASHED",
    emoji: "💥",
    colorVar: "--status-failed",
    hex: "#da3633",
    dotClass: "bg-[var(--status-failed)]",
    borderClass: "border-[var(--status-failed)]",
    bgClass: "bg-[var(--status-failed)]/10",
    priority: 3,
    isUrgent: true,
  },
  converged: {
    key: "converged",
    label: "CONVERGED",
    emoji: "🤜",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  target_reached: {
    key: "target_reached",
    label: "TARGET REACHED",
    emoji: "🎯",
    colorVar: "--accent-green",
    hex: "#3fb950",
    dotClass: "bg-[var(--accent-green)]",
    borderClass: "border-[var(--accent-green)]",
    bgClass: "bg-[var(--accent-green)]/5",
    priority: 2,
    isUrgent: false,
  },
  max_rounds: {
    key: "max_rounds",
    label: "MAX ROUNDS",
    emoji: "🔢",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 1,
    isUrgent: false,
  },
  max_no_improve: {
    key: "max_no_improve",
    label: "NO IMPROVE",
    emoji: "⚠️",
    colorVar: "--accent-orange",
    hex: "#d29922",
    dotClass: "bg-[var(--accent-orange)]",
    borderClass: "border-[var(--accent-orange)]",
    bgClass: "bg-[var(--accent-orange)]/10",
    priority: 1,
    isUrgent: false,
  },
  paused: {
    key: "paused",
    label: "PAUSED",
    emoji: "⏸️",
    colorVar: "--accent-blue",
    hex: "#58a6ff",
    dotClass: "bg-[var(--accent-blue)]",
    borderClass: "border-[var(--accent-blue)]",
    bgClass: "bg-[var(--accent-blue)]/10",
    priority: 1,
    isUrgent: false,
  },
};

// Normalize backend VisualStatus ("todo"|"done") to UIStatus equivalents.
const STATUS_ALIASES: Record<string, UIStatus> = {
  todo: "idle",
  done: "completed",
};

export function getStatusConfig(status: string): StatusConfig {
  const normalized = STATUS_ALIASES[status] ?? status;
  return STATUS_CONFIG[normalized as UIStatus] ?? STATUS_CONFIG.idle;
}

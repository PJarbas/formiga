/**
 * ReportStatusBadge — Badge colorido para status de features/técnicas
 */

import type { StatusType } from "../../lib/parseReportMarkdown";
import { STATUS_TRANSLATIONS } from "../../lib/reportTranslations";

interface StatusConfig {
  icon: string;
  bg: string;
  text: string;
  label: string;
}

const STATUS_CONFIG: Record<StatusType, StatusConfig> = {
  APPLIED: {
    icon: "✓",
    bg: "bg-[var(--accent-green)]/15",
    text: "text-[var(--accent-green)]",
    label: STATUS_TRANSLATIONS.APPLIED,
  },
  REJECTED: {
    icon: "⚠",
    bg: "bg-[var(--accent-orange)]/15",
    text: "text-[var(--accent-orange)]",
    label: STATUS_TRANSLATIONS.REJECTED,
  },
  FAILED: {
    icon: "✕",
    bg: "bg-[var(--accent-red)]/15",
    text: "text-[var(--accent-red)]",
    label: STATUS_TRANSLATIONS.FAILED,
  },
  NA: {
    icon: "—",
    bg: "bg-[var(--bg-tertiary)]",
    text: "text-[var(--text-muted)]",
    label: "N/A",
  },
  KEPT: {
    icon: "✓",
    bg: "bg-[var(--accent-green)]/15",
    text: "text-[var(--accent-green)]",
    label: STATUS_TRANSLATIONS.KEPT,
  },
  DROPPED: {
    icon: "✕",
    bg: "bg-[var(--accent-red)]/15",
    text: "text-[var(--accent-red)]",
    label: STATUS_TRANSLATIONS.DROPPED,
  },
  OBEYED: {
    icon: "✓",
    bg: "bg-[var(--accent-green)]/15",
    text: "text-[var(--accent-green)]",
    label: STATUS_TRANSLATIONS.OBEYED,
  },
  SKIPPED: {
    icon: "→",
    bg: "bg-[var(--bg-tertiary)]",
    text: "text-[var(--text-muted)]",
    label: STATUS_TRANSLATIONS.SKIPPED,
  },
  PENDING: {
    icon: "◌",
    bg: "bg-[var(--accent-blue)]/15",
    text: "text-[var(--accent-blue)]",
    label: STATUS_TRANSLATIONS.PENDING,
  },
  UNKNOWN: {
    icon: "?",
    bg: "bg-[var(--bg-tertiary)]",
    text: "text-[var(--text-muted)]",
    label: "?",
  },
};

interface ReportStatusBadgeProps {
  status: StatusType;
  size?: "sm" | "md";
  showIcon?: boolean;
}

export function ReportStatusBadge({
  status,
  size = "sm",
  showIcon = true,
}: ReportStatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN;

  const sizeClasses = size === "sm"
    ? "text-[10px] px-1.5 py-0.5"
    : "text-xs px-2 py-1";

  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${config.bg} ${config.text} ${sizeClasses}`}
    >
      {showIcon && <span className="leading-none">{config.icon}</span>}
      <span>{config.label}</span>
    </span>
  );
}

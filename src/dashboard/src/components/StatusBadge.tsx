// ══════════════════════════════════════════════════════════════════════
// StatusBadge.tsx — Composition-based status indicator
// ══════════════════════════════════════════════════════════════════════
// Renders emoji + label by default. Consumer overrides via `children`
// render prop for custom layouts. All visual data from STATUS_CONFIG.
// ══════════════════════════════════════════════════════════════════════

import type { ReactNode } from "react";
import { getStatusConfig, type UIStatus } from "../lib/status-config.js";

export interface StatusBadgeProps {
  status: UIStatus | string;
  size?: "sm" | "md" | "lg";
  /** Override default content (emoji + label). Receives the resolved config. */
  children?: (config: { emoji: string; label: string }) => ReactNode;
}

const SIZE_CLASSES = {
  sm: "text-xs px-1.5 py-0.5",
  md: "text-sm px-2 py-0.5",
  lg: "text-base px-3 py-1",
} as const;

export function StatusBadge({ status, size = "md", children }: StatusBadgeProps) {
  const config = getStatusConfig(status);
  const sizeClass = SIZE_CLASSES[size];

  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full font-medium border ${sizeClass} ${config.borderClass} ${config.bgClass}`}
      style={{ color: `var(${config.colorVar})` }}
    >
      {children
        ? children({ emoji: config.emoji, label: config.label })
        : (
          <>
            <span aria-hidden="true" className="text-sm">{config.emoji}</span>
            <span>{config.label}</span>
          </>
        )}
    </span>
  );
}
// ══════════════════════════════════════════════════════════════════════
// ActionBar.tsx — Horizontal row of action buttons
// ══════════════════════════════════════════════════════════════════════

import type { Action } from "@shared/dashboard-types";

export interface ActionBarProps {
  actions: Action[];
  onAction: (actionId: string) => void;
  disabled?: boolean;
}

const VARIANT_CLASSES: Record<NonNullable<Action["variant"]>, string> = {
  default:
    "bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-default)] hover:bg-[var(--border-default)]",
  destructive:
    "bg-transparent text-[var(--accent-red)] border-[var(--accent-red)] hover:bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)]",
  success:
    "bg-transparent text-[var(--accent-green)] border-[var(--accent-green)] hover:bg-[color-mix(in_srgb,var(--accent-green)_15%,transparent)]",
};

export function ActionBar({ actions, onAction, disabled = false }: ActionBarProps) {
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="action-bar">
      {actions.map((action) => {
        const variant = action.variant ?? "default";
        const variantClass = VARIANT_CLASSES[variant];
        const primaryClass = action.primary
          ? "bg-[var(--accent-blue)] text-white border-[var(--accent-blue)] hover:opacity-90"
          : variantClass;
        return (
          <button
            key={action.id}
            type="button"
            disabled={disabled}
            onClick={() => onAction(action.id)}
            data-action-id={action.id}
            data-variant={variant}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${primaryClass}`}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

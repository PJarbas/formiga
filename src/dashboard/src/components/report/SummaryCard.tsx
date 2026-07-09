/**
 * SummaryCard — Card colorido para métricas-chave do report
 */

interface SummaryCardProps {
  icon: string;
  label: string;
  value: string | number;
  subValue?: string;
  status?: "good" | "warning" | "bad" | "neutral";
  tooltip?: string;
}

const STATUS_BORDER: Record<string, string> = {
  good: "border-l-[var(--accent-green)]",
  warning: "border-l-[var(--accent-orange)]",
  bad: "border-l-[var(--accent-red)]",
  neutral: "border-l-[var(--accent-blue)]",
};

const STATUS_ICON_BG: Record<string, string> = {
  good: "bg-[var(--accent-green)]/15 text-[var(--accent-green)]",
  warning: "bg-[var(--accent-orange)]/15 text-[var(--accent-orange)]",
  bad: "bg-[var(--accent-red)]/15 text-[var(--accent-red)]",
  neutral: "bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]",
};

export function SummaryCard({
  icon,
  label,
  value,
  subValue,
  status = "neutral",
  tooltip,
}: SummaryCardProps) {
  return (
    <div
      className={`
        rounded-lg border border-[var(--border-default)] border-l-4
        bg-[var(--bg-secondary)] p-4
        ${STATUS_BORDER[status]}
      `}
      title={tooltip}
    >
      <div className="flex items-start gap-3">
        <div
          className={`
            w-8 h-8 rounded-lg flex items-center justify-center text-base
            ${STATUS_ICON_BG[status]}
          `}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
            {label}
          </div>
          <div className="text-xl font-bold font-mono text-[var(--text-primary)] truncate">
            {value}
          </div>
          {subValue && (
            <div className="text-xs text-[var(--text-muted)] mt-0.5">
              {subValue}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Grid container for summary cards ───────────────────────────────────

interface SummaryCardsGridProps {
  children: React.ReactNode;
}

export function SummaryCardsGrid({ children }: SummaryCardsGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {children}
    </div>
  );
}

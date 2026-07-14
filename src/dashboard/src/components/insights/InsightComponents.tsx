// ══════════════════════════════════════════════════════════════════════
// InsightComponents.tsx — Reusable visual components for agent insights
// MetricCard, QualityBar, AlertBadge, DecisionTimeline, Section
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";

// ── MetricCard ─────────────────────────────────────────────────────────

interface MetricCardProps {
  value: string | number;
  label: string;
  icon?: string;
  trend?: "up" | "down" | "neutral";
  subtitle?: string;
}

export function MetricCard({ value, label, icon, trend, subtitle }: MetricCardProps) {
  const trendColors = {
    up: "text-[var(--accent-green)]",
    down: "text-[var(--accent-red)]",
    neutral: "text-[var(--text-muted)]",
  };

  return (
    <div className="bg-[var(--bg-secondary)] rounded-lg p-3 border border-[var(--border-default)]">
      <div className="flex items-center gap-2">
        {icon && <span className="text-lg">{icon}</span>}
        <span className={`text-xl font-bold ${trend ? trendColors[trend] : "text-[var(--text-primary)]"}`}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
      </div>
      <div className="text-[10px] text-[var(--text-muted)] mt-1 uppercase tracking-wide">{label}</div>
      {subtitle && <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">{subtitle}</div>}
    </div>
  );
}

// ── MetricGrid ─────────────────────────────────────────────────────────

interface MetricGridProps {
  children: React.ReactNode;
  cols?: 2 | 3 | 4;
}

export function MetricGrid({ children, cols = 3 }: MetricGridProps) {
  const gridCols = {
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4",
  };

  return <div className={`grid ${gridCols[cols]} gap-2`}>{children}</div>;
}

// ── QualityBar ─────────────────────────────────────────────────────────

interface QualityBarProps {
  label: string;
  value: number;
  max?: number;
  suffix?: string;
  status?: "good" | "warning" | "bad";
}

export function QualityBar({ label, value, max = 100, suffix = "%", status }: QualityBarProps) {
  const pct = Math.min((value / max) * 100, 100);

  const statusColors = {
    good: "bg-[var(--accent-green)]",
    warning: "bg-[var(--accent-yellow)]",
    bad: "bg-[var(--accent-red)]",
  };

  const autoStatus = pct < 10 ? "good" : pct < 30 ? "warning" : "bad";
  const barColor = status ? statusColors[status] : statusColors[autoStatus];

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <span className="text-[var(--text-muted)] font-mono">
          {value.toFixed(1)}{suffix}
        </span>
      </div>
      <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── AlertBadge ─────────────────────────────────────────────────────────

interface AlertBadgeProps {
  severity: "high" | "medium" | "low" | "info";
  title: string;
  description?: string;
}

export function AlertBadge({ severity, title, description }: AlertBadgeProps) {
  const colors = {
    high: "border-[var(--accent-red)] bg-[var(--accent-red)]/10",
    medium: "border-[var(--accent-yellow)] bg-[var(--accent-yellow)]/10",
    low: "border-[var(--accent-blue)] bg-[var(--accent-blue)]/10",
    info: "border-[var(--border-default)] bg-[var(--bg-secondary)]",
  };

  const icons = {
    high: "⚠️",
    medium: "⚡",
    low: "💡",
    info: "ℹ️",
  };

  const severityLabel = {
    high: "HIGH",
    medium: "MED",
    low: "LOW",
    info: "INFO",
  };

  return (
    <div className={`rounded border px-2 py-1.5 ${colors[severity]}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs">{icons[severity]}</span>
        <span className="text-[10px] font-semibold uppercase text-[var(--text-muted)]">
          {severityLabel[severity]}
        </span>
        <span className="text-xs text-[var(--text-primary)] font-medium">{title}</span>
      </div>
      {description && (
        <p className="text-[10px] text-[var(--text-secondary)] mt-1 ml-5">{description}</p>
      )}
    </div>
  );
}

// ── DecisionTimeline ───────────────────────────────────────────────────

interface DecisionItem {
  round: number;
  label: string;
  value: number | string;
  status: "success" | "failed" | "warning" | "pending";
  detail?: string;
}

interface DecisionTimelineProps {
  items: DecisionItem[];
  maxItems?: number;
}

export function DecisionTimeline({ items, maxItems = 8 }: DecisionTimelineProps) {
  const displayItems = items.slice(0, maxItems);

  const statusStyles = {
    success: { icon: "●", color: "text-[var(--accent-green)]" },
    failed: { icon: "●", color: "text-[var(--accent-red)]" },
    warning: { icon: "●", color: "text-[var(--accent-yellow)]" },
    pending: { icon: "○", color: "text-[var(--text-muted)]" },
  };

  return (
    <div className="space-y-1.5">
      {displayItems.map((item, i) => {
        const style = statusStyles[item.status];
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={`${style.color} text-[10px]`}>{style.icon}</span>
            <span className="text-[var(--text-muted)] w-6">R{item.round}</span>
            <span className="text-[var(--text-primary)] font-medium flex-1 truncate">{item.label}</span>
            <span className="text-[var(--accent-blue)] font-mono">
              {typeof item.value === "number" ? item.value.toFixed(4) : item.value}
            </span>
          </div>
        );
      })}
      {items.length > maxItems && (
        <div className="text-[10px] text-[var(--text-muted)] text-center">
          +{items.length - maxItems} more
        </div>
      )}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  icon?: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  badge?: string | number;
}

export function Section({ title, icon, children, collapsible = false, defaultOpen = true, badge }: SectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const header = (
    <div className="flex items-center gap-2">
      {icon && <span className="text-xs">{icon}</span>}
      <h4 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
        {title}
      </h4>
      {badge !== undefined && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
          {badge}
        </span>
      )}
      {collapsible && (
        <span className="ml-auto text-[var(--text-muted)]">
          {isOpen ? "▼" : "▶"}
        </span>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {collapsible ? (
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="w-full text-left hover:opacity-80 transition-opacity"
        >
          {header}
        </button>
      ) : (
        header
      )}
      {(!collapsible || isOpen) && <div>{children}</div>}
    </div>
  );
}

// ── KeyValueList ───────────────────────────────────────────────────────

interface KeyValueItem {
  key: string;
  value: string | number | React.ReactNode;
  nested?: KeyValueItem[];
}

interface KeyValueListProps {
  items: KeyValueItem[];
}

export function KeyValueList({ items }: KeyValueListProps) {
  return (
    <div className="space-y-1 text-xs">
      {items.map((item, i) => (
        <div key={i}>
          <div className="flex items-start gap-2">
            <span className="text-[var(--text-muted)]">├─</span>
            <span className="text-[var(--text-secondary)]">{item.key}:</span>
            <span className="text-[var(--text-primary)] font-mono">{item.value}</span>
          </div>
          {item.nested && (
            <div className="ml-4">
              {item.nested.map((nested, j) => (
                <div key={j} className="flex items-start gap-2">
                  <span className="text-[var(--text-muted)]">│ └─</span>
                  <span className="text-[var(--text-secondary)]">{nested.key}:</span>
                  <span className="text-[var(--text-primary)] font-mono">{nested.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── InfoBox ────────────────────────────────────────────────────────────

interface InfoBoxProps {
  children: React.ReactNode;
  variant?: "default" | "highlight" | "warning";
}

export function InfoBox({ children, variant = "default" }: InfoBoxProps) {
  const styles = {
    default: "border-[var(--border-default)] bg-[var(--bg-secondary)]",
    highlight: "border-[var(--accent-blue)] bg-[var(--accent-blue)]/5",
    warning: "border-[var(--accent-yellow)] bg-[var(--accent-yellow)]/5",
  };

  return (
    <div className={`rounded border-l-2 px-3 py-2 ${styles[variant]}`}>
      {children}
    </div>
  );
}

// ── FeatureList ────────────────────────────────────────────────────────

interface FeatureListProps {
  features: Array<{ name: string; score?: number; type?: string }>;
  maxItems?: number;
}

export function FeatureList({ features, maxItems = 10 }: FeatureListProps) {
  const displayFeatures = features.slice(0, maxItems);

  return (
    <div className="space-y-1">
      {displayFeatures.map((f, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="text-[var(--text-muted)] w-4">{i + 1}.</span>
          <span className="text-[var(--text-primary)] flex-1 truncate font-mono">{f.name}</span>
          {f.score !== undefined && (
            <span className="text-[var(--accent-blue)] font-mono">{f.score.toFixed(3)}</span>
          )}
          {f.type && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {f.type}
            </span>
          )}
        </div>
      ))}
      {features.length > maxItems && (
        <div className="text-[10px] text-[var(--text-muted)] text-center">
          +{features.length - maxItems} more features
        </div>
      )}
    </div>
  );
}

// ── EmptyInsight ───────────────────────────────────────────────────────

interface EmptyInsightProps {
  message?: string;
  suggestion?: string;
}

export function EmptyInsight({ message = "No data available yet", suggestion }: EmptyInsightProps) {
  return (
    <div className="text-center py-8">
      <div className="text-2xl mb-2 opacity-50">📊</div>
      <p className="text-xs text-[var(--text-muted)]">{message}</p>
      {suggestion && (
        <p className="text-[10px] text-[var(--text-secondary)] mt-1">{suggestion}</p>
      )}
    </div>
  );
}

// ── LoadingInsight ─────────────────────────────────────────────────────

export function LoadingInsight() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-4 bg-[var(--bg-tertiary)] rounded w-3/4" />
      <div className="h-20 bg-[var(--bg-tertiary)] rounded" />
      <div className="h-4 bg-[var(--bg-tertiary)] rounded w-1/2" />
      <div className="h-16 bg-[var(--bg-tertiary)] rounded" />
    </div>
  );
}

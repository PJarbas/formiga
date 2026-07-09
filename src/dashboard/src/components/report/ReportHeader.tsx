/**
 * ReportHeader — Metadados do report em layout visual compacto
 */

import type { ReportHeader as ReportHeaderType } from "../../lib/parseReportMarkdown";
import { formatDate } from "../../lib/reportTranslations";

interface ReportHeaderProps {
  header: ReportHeaderType;
}

const TASK_TYPE_LABELS = {
  regression: "regressão",
  classification: "classificação",
  unknown: "",
};

const REPORT_ICONS: Record<string, string> = {
  "feature-engineer": "🔬",
  "modeler-classic": "⚙️",
  "modeler-advanced": "🚀",
  eda: "📊",
  audit: "🔍",
  unknown: "📄",
};

export function ReportHeader({ header }: ReportHeaderProps) {
  const taskLabel = TASK_TYPE_LABELS[header.taskType];
  const icon = REPORT_ICONS[header.title.toLowerCase().includes("feature") ? "feature-engineer" : "unknown"];

  return (
    <div className="rounded-lg bg-[var(--bg-tertiary)] border-l-4 border-l-[var(--accent-blue)] p-4 mb-4">
      {/* Title */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{icon}</span>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          {header.title}
        </h2>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {header.agent && (
          <MetadataItem label="Agente" value={cleanAgentName(header.agent)} />
        )}

        {header.runId && (
          <MetadataItem
            label="Run"
            value={header.runId.slice(0, 8) + "..."}
            title={header.runId}
            mono
          />
        )}

        {header.date && (
          <MetadataItem label="Data" value={formatDate(header.date)} />
        )}

        {header.dataset && (
          <MetadataItem label="Dataset" value={header.dataset} mono />
        )}

        {header.target && (
          <MetadataItem
            label="Target"
            value={`${header.target}${taskLabel ? ` (${taskLabel})` : ""}`}
            mono
          />
        )}
      </div>
    </div>
  );
}

// ── Helper Components ──────────────────────────────────────────────────

interface MetadataItemProps {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}

function MetadataItem({ label, value, title, mono }: MetadataItemProps) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[var(--text-muted)] text-xs">{label}:</span>
      <span
        className={`text-[var(--text-secondary)] ${mono ? "font-mono text-xs" : ""}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function cleanAgentName(name: string): string {
  // Remove prefixes like "ml-pipeline_"
  const match = name.match(/\(([^)]+)\)/);
  if (match) {
    return name.replace(match[0], "").trim();
  }
  return name.replace(/^ml-pipeline_/, "").replace(/_/g, " ");
}

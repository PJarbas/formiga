/**
 * StructuredReportTab — Nova aba de report com visual estruturado
 *
 * Substitui a renderização genérica de markdown por componentes
 * customizados com tradução para português e melhor UX.
 */

import { useMemo } from "react";
import { parseReportMarkdown } from "../../lib/parseReportMarkdown";
import { ReportHeader } from "./ReportHeader";
import { ReportSummaryCards } from "./ReportSummaryCards";
import { ReportSections } from "./ReportSections";
import { ReportRawToggle } from "./ReportRawToggle";
import { UI_LABELS } from "../../lib/reportTranslations";

interface StructuredReportTabProps {
  content?: string;
  loading?: boolean;
}

export function StructuredReportTab({ content, loading }: StructuredReportTabProps) {
  // Parse the markdown content
  const parsedReport = useMemo(() => {
    if (!content) return null;
    return parseReportMarkdown(content);
  }, [content]);

  // Loading state
  if (loading) {
    return <LoadingState />;
  }

  // Empty state
  if (!content || !parsedReport) {
    return <EmptyState />;
  }

  // Fallback for unknown report types
  if (parsedReport.type === "unknown" && parsedReport.sections.length === 0) {
    return <FallbackMarkdown content={content} />;
  }

  return (
    <div className="space-y-4">
      {/* Header with metadata */}
      <ReportHeader header={parsedReport.header} />

      {/* Summary cards with key metrics */}
      <ReportSummaryCards
        baseline={parsedReport.baseline}
        featureCount={parsedReport.featureCount}
      />

      {/* Collapsible sections */}
      <ReportSections sections={parsedReport.sections} />

      {/* Toggle to view raw markdown */}
      <ReportRawToggle content={parsedReport.rawContent} />
    </div>
  );
}

// ── Helper Components ──────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-3">
        <div className="w-5 h-5 border-2 border-[var(--accent-blue)] border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-[var(--text-muted)]">
          {UI_LABELS.loadingReport}
        </span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-12 h-12 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
        <span className="text-xl">📄</span>
      </div>
      <p className="text-sm text-[var(--text-muted)]">
        {UI_LABELS.noReport}
      </p>
    </div>
  );
}

function FallbackMarkdown({ content }: { content: string }) {
  // For unknown formats, show the raw markdown with basic styling
  return (
    <div className="space-y-4">
      <div className="p-3 rounded bg-[var(--accent-orange)]/10 border border-[var(--accent-orange)]/30">
        <p className="text-xs text-[var(--accent-orange)]">
          ⚠️ Formato de relatório não reconhecido. Exibindo conteúdo original.
        </p>
      </div>

      <div
        className="
          prose prose-invert prose-sm max-w-none
          max-h-[500px] overflow-y-auto
          rounded border border-[var(--border-default)]
          bg-[var(--bg-tertiary)] p-4
        "
      >
        <pre className="whitespace-pre-wrap text-xs font-mono text-[var(--text-secondary)]">
          {content}
        </pre>
      </div>
    </div>
  );
}

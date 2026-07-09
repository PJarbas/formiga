/**
 * FeatureTable — Tabela de features com barras de importância e status
 */

import type { ParsedTable } from "../../lib/parseReportMarkdown";
import { detectStatus } from "../../lib/parseReportMarkdown";
import { ReportStatusBadge } from "./ReportStatusBadge";
import { getTooltip } from "../../lib/reportTranslations";

interface FeatureTableProps {
  table: ParsedTable;
  showImportanceBars?: boolean;
}

export function FeatureTable({ table, showImportanceBars = false }: FeatureTableProps) {
  const { headers, rows } = table;

  // Find status column index
  const statusColIndex = headers.findIndex(
    (h) => h.toLowerCase().includes("status") || h.toLowerCase().includes("result")
  );

  // Find importance/score column index
  const importanceColIndex = headers.findIndex(
    (h) =>
      h.toLowerCase().includes("importance") ||
      h.toLowerCase().includes("score") ||
      h.toLowerCase().includes("mi") ||
      h.toLowerCase().includes("stability")
  );

  // Calculate max importance for bar scaling
  let maxImportance = 1;
  if (showImportanceBars && importanceColIndex >= 0) {
    for (const row of rows) {
      const val = parseNumericValue(row[importanceColIndex]);
      if (val > maxImportance) maxImportance = val;
    }
  }

  return (
    <div className="rounded border border-[var(--border-default)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[var(--bg-tertiary)]">
              {headers.map((header, i) => (
                <th
                  key={i}
                  className="px-3 py-2 text-left font-medium text-[var(--text-secondary)] whitespace-nowrap"
                >
                  <HeaderWithTooltip text={translateHeader(header)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="border-t border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]/50"
              >
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="px-3 py-2 text-[var(--text-primary)]"
                  >
                    {cellIndex === statusColIndex ? (
                      <ReportStatusBadge status={detectStatus(cell)} />
                    ) : cellIndex === importanceColIndex && showImportanceBars ? (
                      <ImportanceCell
                        value={cell}
                        maxValue={maxImportance}
                      />
                    ) : (
                      <CellContent text={cell} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Helper Components ──────────────────────────────────────────────────

function HeaderWithTooltip({ text }: { text: string }) {
  const tooltip = getTooltip(text);

  if (tooltip) {
    return (
      <span className="cursor-help border-b border-dotted border-[var(--text-muted)]" title={tooltip}>
        {text}
      </span>
    );
  }

  return <span>{text}</span>;
}

function CellContent({ text }: { text: string }) {
  // Check for emoji status indicators
  if (text.includes("✅") || text.includes("⚠️") || text.includes("❌")) {
    return <ReportStatusBadge status={detectStatus(text)} />;
  }

  // Check for code/monospace content
  if (text.startsWith("`") && text.endsWith("`")) {
    return (
      <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[var(--accent-blue)] text-[10px]">
        {text.slice(1, -1)}
      </code>
    );
  }

  // Check for percentage
  if (text.match(/^\d+\.?\d*%$/)) {
    const pct = parseFloat(text);
    const color =
      pct >= 70 ? "text-[var(--accent-green)]" :
      pct >= 40 ? "text-[var(--accent-orange)]" :
      "text-[var(--text-muted)]";
    return <span className={`font-mono ${color}`}>{text}</span>;
  }

  return <span>{text}</span>;
}

interface ImportanceCellProps {
  value: string;
  maxValue: number;
}

function ImportanceCell({ value, maxValue }: ImportanceCellProps) {
  const numValue = parseNumericValue(value);
  const percentage = maxValue > 0 ? (Math.abs(numValue) / maxValue) * 100 : 0;

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-[var(--bg-primary)] rounded overflow-hidden min-w-[60px]">
        <div
          className="h-full bg-[var(--accent-blue)] rounded transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-[var(--text-muted)] w-12 text-right">
        {formatImportance(numValue)}
      </span>
    </div>
  );
}

// ── Utilities ──────────────────────────────────────────────────────────

function parseNumericValue(text: string): number {
  // Handle formats like "0.87 ± 0.12" or "87%"
  const match = text.match(/^([-\d.]+)/);
  if (match) {
    return parseFloat(match[1]);
  }
  return 0;
}

function formatImportance(value: number): string {
  if (Math.abs(value) >= 1) return value.toFixed(1);
  if (Math.abs(value) >= 0.01) return value.toFixed(2);
  return value.toFixed(3);
}

const HEADER_TRANSLATIONS: Record<string, string> = {
  "#": "#",
  "Feature": "Feature",
  "Status": "Status",
  "Notes": "Notas",
  "Recommendation": "Recomendação",
  "EDA Recommendation": "Recomendação do EDA",
  "EDA Warning": "Alerta do EDA",
  "Importance": "Importância",
  "Importance (mean)": "Importância (média)",
  "MI Score": "Score MI",
  "mRMR Score": "Score mRMR",
  "mRMR Stability": "Estabilidade mRMR",
  "L1 Stability": "Estabilidade L1",
  "Coefficient": "Coeficiente",
  "Rank": "Rank",
  "Formula": "Fórmula",
  "Motivation": "Motivação",
  "Dropped": "Removido",
  "Kept": "Mantido",
  "Reason": "Motivo",
};

function translateHeader(header: string): string {
  return HEADER_TRANSLATIONS[header] ?? header;
}

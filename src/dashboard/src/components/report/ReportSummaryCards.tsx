/**
 * ReportSummaryCards — Cards de métricas-chave extraídas do report
 */

import type { BaselineMetrics } from "../../lib/parseReportMarkdown";
import { SummaryCard, SummaryCardsGrid } from "./SummaryCard";
import { formatMetric, UI_LABELS } from "../../lib/reportTranslations";

interface ReportSummaryCardsProps {
  baseline: BaselineMetrics | null;
  featureCount: number | null;
  trainValGap?: number;
}

export function ReportSummaryCards({
  baseline,
  featureCount,
  trainValGap,
}: ReportSummaryCardsProps) {
  if (!baseline && !featureCount) {
    return null;
  }

  const gap = trainValGap ?? (baseline?.trainR2 && baseline?.cvMean
    ? Math.abs(baseline.trainR2 - baseline.cvMean)
    : null);

  return (
    <SummaryCardsGrid>
      {baseline?.cvMean !== null && baseline?.cvMean !== undefined && (
        <SummaryCard
          icon="📊"
          label={`${baseline.metric} CV`}
          value={formatMetric(baseline.cvMean)}
          subValue={baseline.cvStd ? `± ${formatMetric(baseline.cvStd)}` : undefined}
          status={getScoreStatus(baseline.cvMean)}
          tooltip={`Média de ${baseline.metric} em validação cruzada`}
        />
      )}

      {baseline?.trainR2 !== null && baseline?.trainR2 !== undefined && (
        <SummaryCard
          icon="🎯"
          label={`${baseline.metric} Treino`}
          value={formatMetric(baseline.trainR2)}
          status="neutral"
          tooltip={`${baseline.metric} no conjunto de treino`}
        />
      )}

      {gap !== null && (
        <SummaryCard
          icon="⚖️"
          label={UI_LABELS.trainValGap}
          value={formatMetric(gap)}
          subValue={getGapLabel(gap)}
          status={getGapStatus(gap)}
          tooltip="Diferença entre performance no treino e validação"
        />
      )}

      {featureCount !== null && (
        <SummaryCard
          icon="🧬"
          label={UI_LABELS.featuresSelected}
          value={featureCount}
          subValue="features"
          status="neutral"
          tooltip="Número de features selecionadas para modelagem"
        />
      )}

      {baseline?.model && (
        <SummaryCard
          icon="⚙️"
          label={UI_LABELS.baselineModel}
          value={cleanModelName(baseline.model)}
          status="neutral"
          tooltip="Modelo base para comparação"
        />
      )}
    </SummaryCardsGrid>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function getScoreStatus(score: number): "good" | "warning" | "bad" | "neutral" {
  if (score >= 0.8) return "good";
  if (score >= 0.5) return "neutral";
  if (score >= 0.3) return "warning";
  return "bad";
}

function getGapStatus(gap: number): "good" | "warning" | "bad" {
  if (gap < 0.05) return "good";
  if (gap < 0.1) return "warning";
  return "bad";
}

function getGapLabel(gap: number): string {
  if (gap < 0.05) return `✅ ${UI_LABELS.lowGap}`;
  if (gap < 0.1) return `⚠️ ${UI_LABELS.moderateGap}`;
  return `❌ ${UI_LABELS.highGap}`;
}

function cleanModelName(model: string): string {
  // Extract just the model name from patterns like "Ridge(alpha=1.0)"
  const match = model.match(/^(\w+)/);
  return match ? match[1] : model;
}

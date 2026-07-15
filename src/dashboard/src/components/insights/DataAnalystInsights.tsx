// ══════════════════════════════════════════════════════════════════════
// DataAnalystInsights.tsx — Insights view for Data Analyst agent
// Shows: dataset overview, data quality, leakage alerts, recommendations
// ══════════════════════════════════════════════════════════════════════

import {
  MetricCard,
  MetricGrid,
  QualityBar,
  AlertBadge,
  Section,
  KeyValueList,
  InfoBox,
  FeatureList,
  EmptyInsight,
  LoadingInsight,
} from "./InsightComponents";

interface EDAReport {
  dataset_overview?: {
    shape?: [number, number];
    dtypes?: Record<string, number>;
    target_type?: string;
    memory_mb?: number;
    class_balance?: Record<string, number>;
  };
  data_quality?: {
    missing_pct?: Record<string, number>;
    duplicate_rows?: number;
    constant_columns?: string[];
    high_cardinality?: string[];
    sentinel_values?: Record<string, number[]>;
  };
  target_analysis?: {
    distribution?: string;
    outliers_pct?: number;
    suggested_transform?: string;
  };
  bivariate_vs_target?: {
    top_20_features?: Array<[string, number]>;
  };
  leakage_alerts?: Array<{
    column: string;
    reason: string;
    severity: "high" | "medium" | "low";
  }>;
  feature_engineering_hypotheses?: string[];
  preprocessing_recommendations?: {
    imputation?: Record<string, string>;
    encoding?: Record<string, string>;
    scaling?: Record<string, string>;
    drop_columns?: string[];
  };
}

interface EDAConfig {
  imputation?: Record<string, string>;
  encoding?: Record<string, string>;
  scaling?: Record<string, string>;
  target_transform?: string | null;
  drop_columns?: string[];
  leakage_columns?: string[];
  high_cardinality_columns?: string[];
  suggested_interactions?: Array<[string, string]>;
}

interface DataAnalystInsightsProps {
  edaReport: EDAReport | null;
  edaConfig: EDAConfig | null;
  hypothesis: string | null;
  isLoading?: boolean;
}

export function DataAnalystInsights({
  edaReport,
  edaConfig,
  hypothesis,
  isLoading,
}: DataAnalystInsightsProps) {
  if (isLoading) {
    return <LoadingInsight />;
  }

  if (!edaReport && !edaConfig) {
    return (
      <EmptyInsight
        message="EDA report not available yet"
        suggestion="The agent is performing exploratory data analysis..."
      />
    );
  }

  const overview = edaReport?.dataset_overview;
  const quality = edaReport?.data_quality;
  const target = edaReport?.target_analysis;
  const topFeatures = edaReport?.bivariate_vs_target?.top_20_features ?? [];
  const leakageAlerts = edaReport?.leakage_alerts ?? [];
  const hypotheses = edaReport?.feature_engineering_hypotheses ?? [];
  const recommendations = edaReport?.preprocessing_recommendations ?? edaConfig;

  const totalMissing = quality?.missing_pct
    ? Object.values(quality.missing_pct).filter((v) => v > 0).length
    : 0;

  const avgMissingPct = quality?.missing_pct
    ? Object.values(quality.missing_pct).reduce((a, b) => a + b, 0) /
      Math.max(Object.keys(quality.missing_pct).length, 1)
    : 0;

  return (
    <div className="space-y-5">
      {/* Key Findings Summary */}
      {overview && (
        <Section title="Key Findings" icon="📊">
          <MetricGrid cols={3}>
            <MetricCard
              value={overview.shape ? `${overview.shape[0].toLocaleString()}` : "—"}
              label="Rows"
              icon="📈"
            />
            <MetricCard
              value={overview.shape ? overview.shape[1] : "—"}
              label="Features"
              icon="📋"
            />
            <MetricCard
              value={overview.memory_mb?.toFixed(1) ?? "—"}
              label="MB"
              icon="💾"
              subtitle="memory footprint"
            />
          </MetricGrid>

          {overview.target_type && (
            <div className="mt-3">
              <InfoBox variant="highlight">
                <div className="flex items-center gap-2">
                  <span className="text-xs">🎯</span>
                  <span className="text-xs text-[var(--text-primary)]">
                    Target: <strong>{overview.target_type}</strong>
                  </span>
                  {target?.distribution && (
                    <span className="text-[10px] text-[var(--text-muted)]">
                      ({target.distribution})
                    </span>
                  )}
                </div>
              </InfoBox>
            </div>
          )}
        </Section>
      )}

      {/* Hypothesis */}
      {hypothesis && (
        <Section title="Hypothesis" icon="💡">
          <InfoBox variant="highlight">
            <p className="text-sm text-[var(--text-primary)] italic leading-relaxed">
              "{hypothesis}"
            </p>
          </InfoBox>
        </Section>
      )}

      {/* Data Quality */}
      {quality && (
        <Section title="Data Quality" icon="🔍">
          <div className="space-y-2">
            <QualityBar
              label="Missing Data"
              value={avgMissingPct * 100}
              suffix="%"
              status={avgMissingPct < 0.05 ? "good" : avgMissingPct < 0.2 ? "warning" : "bad"}
            />
            {totalMissing > 0 && (
              <div className="text-[10px] text-[var(--text-muted)]">
                {totalMissing} columns with missing values
              </div>
            )}

            <QualityBar
              label="Duplicate Rows"
              value={quality.duplicate_rows ?? 0}
              max={overview?.shape?.[0] ?? 100}
              suffix=" rows"
              status={(quality.duplicate_rows ?? 0) === 0 ? "good" : "warning"}
            />

            {quality.high_cardinality && quality.high_cardinality.length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] text-[var(--text-muted)] mb-1">High Cardinality:</div>
                <div className="flex flex-wrap gap-1">
                  {quality.high_cardinality.map((col) => (
                    <span
                      key={col}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-yellow)]/20 text-[var(--text-secondary)] font-mono"
                    >
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {quality.sentinel_values && Object.keys(quality.sentinel_values).length > 0 && (
              <div className="mt-2">
                <div className="text-[10px] text-[var(--text-muted)] mb-1">Sentinel Values:</div>
                {Object.entries(quality.sentinel_values).map(([col, vals]) => (
                  <div key={col} className="text-[10px] text-[var(--text-secondary)]">
                    <span className="font-mono">{col}</span>: [{vals.join(", ")}]
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Leakage Alerts */}
      {leakageAlerts.length > 0 && (
        <Section title="Leakage Alerts" icon="⚠️" badge={leakageAlerts.length}>
          <div className="space-y-2">
            {leakageAlerts.map((alert, i) => (
              <AlertBadge
                key={i}
                severity={alert.severity}
                title={alert.column}
                description={alert.reason}
              />
            ))}
          </div>
        </Section>
      )}

      {/* Top Features */}
      {topFeatures.length > 0 && (
        <Section title="Top Features vs Target" icon="📊" badge={topFeatures.length}>
          <FeatureList
            features={topFeatures.map(([name, score]) => ({ name, score }))}
            maxItems={10}
          />
        </Section>
      )}

      {/* Recommendations */}
      {recommendations && (
        <Section title="Recommendations" icon="📝" collapsible defaultOpen={false}>
          <div className="space-y-3">
            {recommendations.imputation && Object.keys(recommendations.imputation).length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-[var(--text-muted)] mb-1">Imputation</div>
                <KeyValueList
                  items={Object.entries(recommendations.imputation).map(([k, v]) => ({
                    key: k,
                    value: v,
                  }))}
                />
              </div>
            )}

            {recommendations.encoding && Object.keys(recommendations.encoding).length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-[var(--text-muted)] mb-1">Encoding</div>
                <KeyValueList
                  items={Object.entries(recommendations.encoding).map(([k, v]) => ({
                    key: k,
                    value: v,
                  }))}
                />
              </div>
            )}

            {recommendations.drop_columns && recommendations.drop_columns.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-[var(--text-muted)] mb-1">Drop Columns</div>
                <div className="flex flex-wrap gap-1">
                  {recommendations.drop_columns.map((col) => (
                    <span
                      key={col}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-red)]/20 text-[var(--text-secondary)] font-mono"
                    >
                      {col}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Feature Engineering Hypotheses */}
      {hypotheses.length > 0 && (
        <Section title="FE Suggestions" icon="🔧" collapsible defaultOpen={false}>
          <ul className="space-y-1">
            {hypotheses.map((h, i) => (
              <li key={i} className="text-xs text-[var(--text-secondary)] flex gap-2">
                <span className="text-[var(--text-muted)]">•</span>
                {h}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

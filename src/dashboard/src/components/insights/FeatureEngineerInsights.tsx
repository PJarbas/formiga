// ══════════════════════════════════════════════════════════════════════
// FeatureEngineerInsights.tsx — Insights view for Feature Engineer agent
// Shows: features summary, baseline model, split config, created features
// ══════════════════════════════════════════════════════════════════════

import {
  MetricCard,
  MetricGrid,
  Section,
  KeyValueList,
  InfoBox,
  EmptyInsight,
  LoadingInsight,
} from "./InsightComponents";

interface FeaturesMetadata {
  shape?: [number, number];
  columns?: string[];
  dtypes?: Record<string, string>;
  split_distribution?: Record<string, number>;
  target_column?: string;
  created_features?: string[];
  dropped_columns?: string[];
}

interface SplitConfig {
  random_state?: number;
  strategy?: string;
  train_size?: number;
  val_size?: number;
  test_size?: number;
  n_folds?: number;
}

interface BaselineSubmission {
  MODEL_TYPE?: string;
  CV_MEAN?: number;
  CV_STD?: number;
  TRAIN_MEAN?: number;
  HYPERPARAMETERS?: Record<string, unknown>;
  ARTIFACT_PATH?: string;
  METRIC_NAME?: string;
}

interface BenchmarkConfig {
  type?: string;
  metric?: {
    name?: string;
    direction?: string;
  };
  validation?: {
    strategy?: string;
    nSplits?: number;
    randomState?: number;
  };
  baseline?: {
    cv_rmse_mean?: number;
    model_type?: string;
  };
}

interface FeatureEngineerInsightsProps {
  featuresMetadata: FeaturesMetadata | null;
  splitConfig: SplitConfig | null;
  baselineSubmission: BaselineSubmission | null;
  benchmarkConfig: BenchmarkConfig | null;
  hypothesis: string | null;
  isLoading?: boolean;
}

export function FeatureEngineerInsights({
  featuresMetadata,
  splitConfig,
  baselineSubmission,
  benchmarkConfig,
  hypothesis,
  isLoading,
}: FeatureEngineerInsightsProps) {
  if (isLoading) {
    return <LoadingInsight />;
  }

  if (!featuresMetadata && !baselineSubmission) {
    return (
      <EmptyInsight
        message="Feature engineering not complete yet"
        suggestion="The agent is creating features and baseline model..."
      />
    );
  }

  const createdFeatures = featuresMetadata?.created_features ?? [];
  const droppedColumns = featuresMetadata?.dropped_columns ?? [];
  const splitDist = featuresMetadata?.split_distribution;

  return (
    <div className="space-y-5">
      {/* Features Summary */}
      {featuresMetadata && (
        <Section title="Features Summary" icon="📋">
          <MetricGrid cols={3}>
            <MetricCard
              value={featuresMetadata.shape?.[0]?.toLocaleString() ?? "—"}
              label="Samples"
              icon="📊"
            />
            <MetricCard
              value={featuresMetadata.shape?.[1] ?? "—"}
              label="Features"
              icon="📈"
            />
            <MetricCard
              value={createdFeatures.length}
              label="Created"
              icon="✨"
              trend={createdFeatures.length > 0 ? "up" : "neutral"}
            />
          </MetricGrid>

          {featuresMetadata.target_column && (
            <div className="mt-3">
              <InfoBox>
                <div className="flex items-center gap-2">
                  <span className="text-xs">🎯</span>
                  <span className="text-xs text-[var(--text-primary)]">
                    Target: <span className="font-mono">{featuresMetadata.target_column}</span>
                  </span>
                </div>
              </InfoBox>
            </div>
          )}
        </Section>
      )}

      {/* Hypothesis */}
      {hypothesis && (
        <Section title="Approach" icon="💡">
          <InfoBox variant="highlight">
            <p className="text-sm text-[var(--text-primary)] italic leading-relaxed">
              "{hypothesis}"
            </p>
          </InfoBox>
        </Section>
      )}

      {/* Baseline Model */}
      {baselineSubmission && (
        <Section title="Baseline Model" icon="🏁">
          <div className="bg-[var(--bg-secondary)] rounded-lg p-3 border border-[var(--border-default)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {baselineSubmission.MODEL_TYPE ?? "Unknown"}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                baseline
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[var(--text-muted)]">CV Mean:</span>
                <span className="ml-1 font-mono text-[var(--accent-blue)]">
                  {baselineSubmission.CV_MEAN?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">CV Std:</span>
                <span className="ml-1 font-mono text-[var(--text-secondary)]">
                  ±{baselineSubmission.CV_STD?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Train Mean:</span>
                <span className="ml-1 font-mono text-[var(--text-secondary)]">
                  {baselineSubmission.TRAIN_MEAN?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Metric:</span>
                <span className="ml-1 font-mono text-[var(--text-secondary)]">
                  {baselineSubmission.METRIC_NAME ?? "—"}
                </span>
              </div>
            </div>

            {baselineSubmission.HYPERPARAMETERS &&
              Object.keys(baselineSubmission.HYPERPARAMETERS).length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--border-default)]">
                  <div className="text-[10px] text-[var(--text-muted)] mb-1">Hyperparameters:</div>
                  <div className="text-[10px] font-mono text-[var(--text-secondary)]">
                    {JSON.stringify(baselineSubmission.HYPERPARAMETERS)}
                  </div>
                </div>
              )}
          </div>
        </Section>
      )}

      {/* Split Configuration */}
      {(splitConfig || splitDist) && (
        <Section title="Split Configuration" icon="✂️">
          <div className="space-y-3">
            {splitDist && (
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(splitDist).map(([key, value]) => (
                  <div key={key} className="bg-[var(--bg-secondary)] rounded p-2 text-center">
                    <div className="text-lg font-bold text-[var(--text-primary)]">
                      {value.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] uppercase">{key}</div>
                  </div>
                ))}
              </div>
            )}

            {splitConfig && (
              <KeyValueList
                items={[
                  { key: "Strategy", value: splitConfig.strategy ?? "—" },
                  { key: "K-Folds", value: splitConfig.n_folds ?? "—" },
                  { key: "Random State", value: splitConfig.random_state ?? "—" },
                ]}
              />
            )}
          </div>
        </Section>
      )}

      {/* Created Features */}
      {createdFeatures.length > 0 && (
        <Section title="Created Features" icon="✨" badge={createdFeatures.length}>
          <div className="flex flex-wrap gap-1">
            {createdFeatures.map((f) => (
              <span
                key={f}
                className="text-[10px] px-2 py-1 rounded bg-[var(--accent-green)]/20 text-[var(--text-primary)] font-mono"
              >
                {f}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Dropped Columns */}
      {droppedColumns.length > 0 && (
        <Section title="Dropped Columns" icon="🗑️" badge={droppedColumns.length} collapsible defaultOpen={false}>
          <div className="flex flex-wrap gap-1">
            {droppedColumns.map((col) => (
              <span
                key={col}
                className="text-[10px] px-2 py-1 rounded bg-[var(--accent-red)]/20 text-[var(--text-secondary)] font-mono line-through"
              >
                {col}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Benchmark Config */}
      {benchmarkConfig && (
        <Section title="Benchmark Config" icon="⚙️" collapsible defaultOpen={false}>
          <div className="bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border-default)]">
            <KeyValueList
              items={[
                { key: "Type", value: benchmarkConfig.type ?? "—" },
                { key: "Metric", value: benchmarkConfig.metric?.name ?? "—" },
                { key: "Direction", value: benchmarkConfig.metric?.direction ?? "—" },
                { key: "Validation", value: benchmarkConfig.validation?.strategy ?? "—" },
              ]}
            />
          </div>
        </Section>
      )}
    </div>
  );
}

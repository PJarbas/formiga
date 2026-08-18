// ══════════════════════════════════════════════════════════════════════
// FeatureEngineerInsights.tsx — Insights view for Feature Engineer agent
// Renders the REAL artifacts the arena persists: features_metadata is a
// quality-gate report (verdict + per-gate status), baseline_submission uses
// lowercase keys, and features_report carries the rich narrative plus the
// created/dropped feature lists. Regression for issue #127 (empty insights
// panel caused by a schema mismatch).
// ══════════════════════════════════════════════════════════════════════

import {
  MetricCard,
  MetricGrid,
  Section,
  KeyValueList,
  InfoBox,
  EmptyInsight,
  LoadingInsight,
  DecisionTimeline,
} from "./InsightComponents";
import { FigureGallery } from "./FigureGallery";

// ── Artifact schemas (as persisted by the arena) ───────────────────────

/** features_metadata — a quality-gate report, not a dataset description. */
interface FeaturesMetadata {
  date?: string;
  verdict?: string;
  blocking_failed?: string[];
  n_warnings?: number;
  gates?: Array<{
    gate: string;
    name: string;
    blocking: boolean;
    status: string;
    value: number;
    detail?: string;
  }>;
  notes?: string;
}

interface SplitConfig {
  random_state?: number;
  strategy?: string;
  train_size?: number;
  val_size?: number;
  test_size?: number;
  n_folds?: number;
}

/** baseline_submission — lowercase keys, numeric metrics. */
interface BaselineSubmission {
  model_type?: string;
  metric?: string;
  cv_mean?: number;
  cv_std?: number;
  cv_folds?: number[];
  train_auc_mean?: number;
  brier_mean?: number;
  hyperparameters?: Record<string, unknown>;
  validation_strategy?: string;
  n_samples?: number;
  n_features?: number;
  base_rate?: number;
}

/** features_report — rich narrative + created/dropped feature lists. */
interface FeaturesReport {
  summary?: string;
  feature_count_final?: number;
  n_rows_cv?: number;
  n_rows_oot?: number;
  dropped_columns?: string[];
  created_features?: string[];
  hypotheses_addressed?: string[];
  quality_gate?: { passed?: number; failed?: number; warnings?: number; verdict?: string };
  baseline?: { model_type?: string; cv_mean?: number; cv_std?: number; train_mean?: number; brier?: number };
  baseline_is_competitive?: boolean;
}

interface BenchmarkConfig {
  type?: string;
  metric?: { name?: string; direction?: string };
  validation?: { strategy?: string; nSplits?: number; gap?: number; sortColumn?: string; randomState?: number };
  target_column?: string;
  id_column?: string;
  baseline?: { cv_auc_mean?: number; cv_auc_std?: number; model_type?: string };
  oot_holdout?: { enabled?: boolean; split_description?: string };
  compute_budget?: { tier?: string; max_fit_seconds?: number; max_trials?: number };
  dropped_columns?: string[];
}

interface FeatureEngineerInsightsProps {
  featuresMetadata: FeaturesMetadata | null;
  splitConfig: SplitConfig | null;
  baselineSubmission: BaselineSubmission | null;
  benchmarkConfig: BenchmarkConfig | null;
  featuresReport: FeaturesReport | null;
  hypothesis: string | null;
  figures?: Array<{ title: string; url: string; path: string; section?: string }>;
  decisions?: Array<{
    key: string;
    decision_type?: string;
    description?: string;
    reasoning?: string;
    alternatives_considered?: string[];
    timestamp?: string;
    loggedAt: string;
  }>;
  isLoading?: boolean;
}

function verdictStyle(verdict?: string): string {
  switch (verdict) {
    case "PASS":
      return "bg-[var(--accent-green)]/20 text-[var(--accent-green)]";
    case "WARN":
      return "bg-[var(--accent-yellow)]/20 text-[var(--accent-yellow)]";
    case "FAIL":
      return "bg-[var(--accent-red)]/20 text-[var(--accent-red)]";
    default:
      return "bg-[var(--bg-tertiary)] text-[var(--text-muted)]";
  }
}

function gateStatusStyle(status: string): string {
  if (status === "PASS") return "bg-[var(--accent-green)]/20 text-[var(--accent-green)]";
  if (status === "WARN") return "bg-[var(--accent-yellow)]/20 text-[var(--accent-yellow)]";
  return "bg-[var(--accent-red)]/20 text-[var(--accent-red)]";
}

export function FeatureEngineerInsights({
  featuresMetadata,
  splitConfig,
  baselineSubmission,
  benchmarkConfig,
  featuresReport,
  hypothesis,
  figures = [],
  decisions = [],
  isLoading,
}: FeatureEngineerInsightsProps) {
  if (isLoading) {
    return <LoadingInsight />;
  }

  if (!featuresMetadata && !baselineSubmission && !featuresReport) {
    return (
      <EmptyInsight
        message="Feature engineering not complete yet"
        suggestion="The agent is creating features and baseline model..."
      />
    );
  }

  const gates = featuresMetadata?.gates ?? [];
  const createdFeatures = featuresReport?.created_features ?? [];
  const droppedColumns = featuresReport?.dropped_columns ?? [];

  return (
    <div className="space-y-5">
      {/* Quality Gates */}
      {gates.length > 0 && (
        <Section title="Quality Gates" icon="🧪">
          <div className="flex items-center gap-2 mb-2">
            {featuresMetadata?.verdict && (
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${verdictStyle(featuresMetadata.verdict)}`}
              >
                {featuresMetadata.verdict}
              </span>
            )}
            {typeof featuresMetadata?.n_warnings === "number" && (
              <span className="text-[10px] text-[var(--text-muted)]">
                {featuresMetadata.n_warnings} warning(s)
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {gates.map((g) => (
              <div
                key={g.gate}
                className="flex items-center gap-2 text-xs bg-[var(--bg-secondary)] rounded border border-[var(--border-default)] px-2 py-1.5"
              >
                <span className="font-mono text-[var(--text-primary)] whitespace-nowrap">
                  {g.gate} · {g.name}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-auto ${gateStatusStyle(g.status)}`}>
                  {g.status}
                </span>
              </div>
            ))}
          </div>

          {featuresMetadata?.notes && (
            <div className="mt-2">
              <InfoBox>
                <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                  {featuresMetadata.notes}
                </p>
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
                {baselineSubmission.model_type ?? "Unknown"}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                baseline
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[var(--text-muted)]">Metric:</span>
                <span className="ml-1 font-mono text-[var(--accent-blue)]">
                  {baselineSubmission.metric ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">CV Mean:</span>
                <span className="ml-1 font-mono text-[var(--accent-blue)]">
                  {baselineSubmission.cv_mean?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">CV Std:</span>
                <span className="ml-1 font-mono text-[var(--text-secondary)]">
                  ±{baselineSubmission.cv_std?.toFixed(4) ?? "—"}
                </span>
              </div>
              <div>
                <span className="text-[var(--text-muted)]">Train Mean:</span>
                <span className="ml-1 font-mono text-[var(--text-secondary)]">
                  {baselineSubmission.train_auc_mean?.toFixed(4) ?? "—"}
                </span>
              </div>
            </div>

            {baselineSubmission.hyperparameters &&
              Object.keys(baselineSubmission.hyperparameters).length > 0 && (
                <div className="mt-2 pt-2 border-t border-[var(--border-default)]">
                  <div className="text-[10px] text-[var(--text-muted)] mb-1">Hyperparameters:</div>
                  <div className="text-[10px] font-mono text-[var(--text-secondary)]">
                    {JSON.stringify(baselineSubmission.hyperparameters)}
                  </div>
                </div>
              )}

            <div className="mt-2 pt-2 border-t border-[var(--border-default)]">
              <KeyValueList
                items={[
                  {
                    key: "Validation",
                    value: baselineSubmission.validation_strategy ?? "—",
                  },
                  { key: "Samples", value: baselineSubmission.n_samples?.toLocaleString() ?? "—" },
                  { key: "Features", value: baselineSubmission.n_features ?? "—" },
                  { key: "Base rate", value: baselineSubmission.base_rate?.toFixed(4) ?? "—" },
                ]}
              />
            </div>
          </div>
        </Section>
      )}

      {/* Features Report */}
      {featuresReport && (
        <Section title="Features Report" icon="📋">
          {featuresReport.summary && (
            <InfoBox>
              <p className="text-xs text-[var(--text-primary)] leading-relaxed">
                {featuresReport.summary}
              </p>
            </InfoBox>
          )}

          <div className="mt-3">
            <MetricGrid cols={3}>
              <MetricCard
                value={featuresReport.feature_count_final ?? "—"}
                label="Features"
                icon="📈"
              />
              <MetricCard
                value={featuresReport.n_rows_cv?.toLocaleString() ?? "—"}
                label="CV Rows"
                icon="📊"
              />
              <MetricCard
                value={featuresReport.n_rows_oot?.toLocaleString() ?? "—"}
                label="OOT Rows"
                icon="🔍"
              />
            </MetricGrid>
          </div>

          {featuresReport.baseline_is_competitive !== undefined && (
            <div className="mt-2">
              <InfoBox
                variant={featuresReport.baseline_is_competitive ? "default" : "warning"}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs">
                    {featuresReport.baseline_is_competitive ? "✅" : "⚠️"}
                  </span>
                  <span className="text-xs text-[var(--text-primary)]">
                    {featuresReport.baseline_is_competitive
                      ? "Feature set competitive vs baseline"
                      : "Feature set not yet competitive vs baseline"}
                  </span>
                </div>
              </InfoBox>
            </div>
          )}

          {featuresReport.hypotheses_addressed &&
            featuresReport.hypotheses_addressed.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">
                  Hypotheses addressed
                </div>
                <div className="space-y-1">
                  {featuresReport.hypotheses_addressed.map((h) => (
                    <div key={h} className="flex items-start gap-2 text-xs">
                      <span className="text-[var(--accent-blue)]">▸</span>
                      <span className="text-[var(--text-secondary)]">{h}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
        <Section title="Dropped Columns" icon="🗑️" badge={droppedColumns.length} collapsible>
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

      {/* Split Configuration */}
      {splitConfig && (
        <Section title="Split Configuration" icon="✂️">
          <KeyValueList
            items={[
              { key: "Strategy", value: splitConfig.strategy ?? "—" },
              { key: "K-Folds", value: splitConfig.n_folds ?? "—" },
              { key: "Random State", value: splitConfig.random_state ?? "—" },
            ]}
          />
        </Section>
      )}

      {/* Benchmark Config */}
      {benchmarkConfig && (
        <Section title="Benchmark Config" icon="⚙️" collapsible>
          <KeyValueList
            items={[
              { key: "Type", value: benchmarkConfig.type ?? "—" },
              {
                key: "Metric",
                value: benchmarkConfig.metric
                  ? `${benchmarkConfig.metric.name} (${benchmarkConfig.metric.direction})`
                  : "—",
              },
              { key: "Target", value: benchmarkConfig.target_column ?? "—" },
              { key: "ID Column", value: benchmarkConfig.id_column ?? "—" },
              { key: "Validation", value: benchmarkConfig.validation?.strategy ?? "—" },
              { key: "Splits", value: benchmarkConfig.validation?.nSplits ?? "—" },
              { key: "Gap", value: benchmarkConfig.validation?.gap ?? "—" },
              { key: "Sort", value: benchmarkConfig.validation?.sortColumn ?? "—" },
            ]}
          />

          {benchmarkConfig.oot_holdout && (
            <div className="mt-2">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">
                OOT holdout
              </div>
              <InfoBox variant={benchmarkConfig.oot_holdout.enabled ? "default" : "warning"}>
                <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
                  {benchmarkConfig.oot_holdout.split_description ??
                    (benchmarkConfig.oot_holdout.enabled ? "Enabled" : "Disabled")}
                </p>
              </InfoBox>
            </div>
          )}

          {benchmarkConfig.compute_budget && (
            <div className="mt-2 pt-2 border-t border-[var(--border-default)]">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">
                Compute budget
              </div>
              <KeyValueList
                items={[
                  { key: "Tier", value: benchmarkConfig.compute_budget.tier ?? "—" },
                  { key: "Max fit (s)", value: benchmarkConfig.compute_budget.max_fit_seconds ?? "—" },
                  { key: "Max trials", value: benchmarkConfig.compute_budget.max_trials ?? "—" },
                ]}
              />
            </div>
          )}
        </Section>
      )}

      {/* Figures / Visualizations */}
      {figures.length > 0 && (
        <Section title="Visualizations" icon="📈" badge={figures.length}>
          <FigureGallery figures={figures} />
        </Section>
      )}

      {/* Decisions Timeline */}
      {decisions.length > 0 && (
        <Section title="Decisions Timeline" icon="🧭" badge={decisions.length}>
          <DecisionTimeline
            items={decisions.map((d, i) => ({
              round: i + 1,
              label: d.description ?? d.decision_type ?? "Decision",
              value: d.reasoning ?? "",
              status: "success" as const,
            }))}
            maxItems={8}
          />
        </Section>
      )}
    </div>
  );
}

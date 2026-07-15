// ══════════════════════════════════════════════════════════════════════
// ModelerInsights.tsx — Insights view for Modeler agents (Classic/Advanced)
// Shows: current best, hypothesis, key decisions, learned, next focus
// ══════════════════════════════════════════════════════════════════════

import {
  MetricCard,
  MetricGrid,
  Section,
  InfoBox,
  DecisionTimeline,
  EmptyInsight,
  LoadingInsight,
} from "./InsightComponents";
import type { AgentKeyDecision } from "@shared/dashboard-types";

interface ModelerInsightsProps {
  agentType: "classic" | "advanced";
  currentBest: {
    modelType: string;
    cvMean: number;
    round: number;
    agent: string;
  } | null;
  hypothesis: string | null;
  learned: string | null;
  nextFocus: string | null;
  keyDecisions: AgentKeyDecision[];
  totalTrials: number;
  isLoading?: boolean;
}

export function ModelerInsights({
  agentType,
  currentBest,
  hypothesis,
  learned,
  nextFocus,
  keyDecisions,
  totalTrials,
  isLoading,
}: ModelerInsightsProps) {
  if (isLoading) {
    return <LoadingInsight />;
  }

  const hasAnyData = currentBest || hypothesis || keyDecisions.length > 0;

  if (!hasAnyData) {
    return (
      <EmptyInsight
        message={`${agentType === "classic" ? "Classic" : "Advanced"} modeler not started`}
        suggestion="Waiting for feature engineering to complete..."
      />
    );
  }

  const icon = agentType === "classic" ? "🌲" : "🧠";
  const label = agentType === "classic" ? "Classical ML" : "Advanced ML";

  const successfulTrials = keyDecisions.filter(
    (d) => d.status === "SUCCESS" || d.status === "AUDITED"
  ).length;
  const failedTrials = keyDecisions.filter(
    (d) => d.status === "FAILED" || d.status === "OVERFITTED"
  ).length;

  return (
    <div className="space-y-5">
      {/* Current Best */}
      {currentBest && (
        <Section title="Current Best" icon="🏆">
          <div className="bg-gradient-to-r from-[var(--accent-green)]/10 to-transparent rounded-lg p-3 border border-[var(--accent-green)]/30">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{icon}</span>
                <span className="text-sm font-bold text-[var(--text-primary)]">
                  {currentBest.modelType}
                </span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-green)]/20 text-[var(--accent-green)]">
                R{currentBest.round}
              </span>
            </div>
            <div className="text-2xl font-bold text-[var(--accent-green)] font-mono">
              {currentBest.cvMean.toFixed(4)}
            </div>
            <div className="text-[10px] text-[var(--text-muted)] mt-1">CV Mean Score</div>
          </div>
        </Section>
      )}

      {/* Stats */}
      <Section title="Trial Stats" icon="📊">
        <MetricGrid cols={3}>
          <MetricCard
            value={totalTrials}
            label="Total"
            icon="🔬"
          />
          <MetricCard
            value={successfulTrials}
            label="Success"
            icon="✅"
            trend="up"
          />
          <MetricCard
            value={failedTrials}
            label="Failed"
            icon="❌"
            trend={failedTrials > 0 ? "down" : "neutral"}
          />
        </MetricGrid>
      </Section>

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

      {/* Key Decisions Timeline */}
      {keyDecisions.length > 0 && (
        <Section title="Key Decisions" icon="🎯" badge={keyDecisions.length}>
          <DecisionTimeline
            items={keyDecisions.map((d) => ({
              round: d.roundNumber,
              label: d.modelType,
              value: d.cvMean,
              status:
                d.status === "AUDITED" || d.status === "SUCCESS"
                  ? "success"
                  : d.status === "FAILED"
                  ? "failed"
                  : d.status === "OVERFITTED"
                  ? "warning"
                  : "pending",
              detail: d.reason ?? undefined,
            }))}
            maxItems={8}
          />
        </Section>
      )}

      {/* Learned */}
      {learned && (
        <Section title="Learned" icon="📚">
          <InfoBox>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{learned}</p>
          </InfoBox>
        </Section>
      )}

      {/* Next Focus */}
      {nextFocus && (
        <Section title="Next Focus" icon="🔮">
          <InfoBox variant="highlight">
            <p className="text-xs text-[var(--accent-blue)] leading-relaxed">{nextFocus}</p>
          </InfoBox>
        </Section>
      )}

      {/* Model Families */}
      <Section title={`${label} Toolkit`} icon={icon} collapsible defaultOpen={false}>
        <div className="grid grid-cols-2 gap-1 text-[10px]">
          {agentType === "classic" ? (
            <>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">XGBoost</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">LightGBM</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">CatBoost</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">RandomForest</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">Ridge/Lasso</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">SVM</div>
            </>
          ) : (
            <>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">TabPFN</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">FT-Transformer</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">TabNet</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">Neural Net</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">AutoML</div>
              <div className="px-2 py-1 bg-[var(--bg-secondary)] rounded">SAINT</div>
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

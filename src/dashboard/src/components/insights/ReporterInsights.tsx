// ══════════════════════════════════════════════════════════════════════
// ReporterInsights.tsx — Insights view for Arena Reporter agent
// Shows: executive summary, competition stats, winner, recommendations
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

interface ArenaReport {
  executive_summary?: string;
  competition_stats?: {
    total_rounds?: number;
    total_models_trained?: number;
    agents_participated?: string[];
    total_training_time_seconds?: number;
    stop_reason?: string;
  };
  leaderboard_snapshot?: Array<{
    rank: number;
    model_type: string;
    cv_mean: number;
    agent: string;
    round: number;
  }>;
  winner?: {
    model_type?: string;
    cv_mean?: number;
    agent?: string;
    round?: number;
    hypothesis?: string;
    strengths?: string[];
  };
  recommendations?: string[];
}

interface CompetitionTimeline {
  rounds?: Array<{
    round: number;
    best_cv: number;
    leader: string;
  }>;
  convergence_round?: number;
  improvement_over_baseline_pct?: number;
}

interface ReporterInsightsProps {
  arenaReport: ArenaReport | null;
  competitionTimeline: CompetitionTimeline | null;
  isLoading?: boolean;
}

export function ReporterInsights({
  arenaReport,
  competitionTimeline,
  isLoading,
}: ReporterInsightsProps) {
  if (isLoading) {
    return <LoadingInsight />;
  }

  if (!arenaReport) {
    return (
      <EmptyInsight
        message="Arena report not available yet"
        suggestion="The reporter will summarize results after the arena completes..."
      />
    );
  }

  const stats = arenaReport.competition_stats;
  const winner = arenaReport.winner;
  const leaderboard = arenaReport.leaderboard_snapshot ?? [];
  const recommendations = arenaReport.recommendations ?? [];
  const timeline = competitionTimeline?.rounds ?? [];

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  return (
    <div className="space-y-5">
      {/* Executive Summary */}
      {arenaReport.executive_summary && (
        <Section title="Executive Summary" icon="📋">
          <InfoBox variant="highlight">
            <p className="text-sm text-[var(--text-primary)] leading-relaxed">
              {arenaReport.executive_summary}
            </p>
          </InfoBox>
        </Section>
      )}

      {/* Competition Stats */}
      {stats && (
        <Section title="Competition Stats" icon="📊">
          <MetricGrid cols={2}>
            <MetricCard
              value={stats.total_rounds ?? 0}
              label="Rounds"
              icon="🔄"
            />
            <MetricCard
              value={stats.total_models_trained ?? 0}
              label="Models"
              icon="🤖"
            />
            <MetricCard
              value={stats.total_training_time_seconds ? formatDuration(stats.total_training_time_seconds) : "—"}
              label="Duration"
              icon="⏱️"
            />
            <MetricCard
              value={competitionTimeline?.improvement_over_baseline_pct?.toFixed(1) ?? "—"}
              label="% vs Baseline"
              icon="📈"
              trend="up"
            />
          </MetricGrid>

          {stats.stop_reason && (
            <div className="mt-2 text-[10px] text-center">
              <span className="px-2 py-1 rounded-full bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                Stop reason: {stats.stop_reason}
              </span>
            </div>
          )}
        </Section>
      )}

      {/* Winner */}
      {winner && (
        <Section title="Winner" icon="🏆">
          <div className="bg-gradient-to-r from-[var(--accent-yellow)]/10 to-transparent rounded-lg p-4 border border-[var(--accent-yellow)]/30">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🥇</span>
                <div>
                  <div className="text-lg font-bold text-[var(--text-primary)]">
                    {winner.model_type}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)]">
                    by {winner.agent} • Round {winner.round}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-[var(--accent-green)] font-mono">
                  {winner.cv_mean?.toFixed(4)}
                </div>
                <div className="text-[10px] text-[var(--text-muted)]">CV Score</div>
              </div>
            </div>

            {winner.hypothesis && (
              <div className="text-xs text-[var(--text-secondary)] italic mb-2">
                "{winner.hypothesis}"
              </div>
            )}

            {winner.strengths && winner.strengths.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {winner.strengths.map((s, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-green)]/20 text-[var(--accent-green)]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Leaderboard */}
      {leaderboard.length > 0 && (
        <Section title="Final Leaderboard" icon="🏅" badge={leaderboard.length}>
          <div className="space-y-1">
            {leaderboard.slice(0, 5).map((entry) => {
              const medals = ["🥇", "🥈", "🥉"];
              const medal = entry.rank <= 3 ? medals[entry.rank - 1] : `#${entry.rank}`;

              return (
                <div
                  key={entry.rank}
                  className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-[var(--bg-secondary)]"
                >
                  <span className="w-6">{medal}</span>
                  <span className="flex-1 font-medium text-[var(--text-primary)]">
                    {entry.model_type}
                  </span>
                  <span className="text-[var(--text-muted)]">{entry.agent}</span>
                  <span className="font-mono text-[var(--accent-blue)]">
                    {entry.cv_mean.toFixed(4)}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Convergence Timeline */}
      {timeline.length > 0 && (
        <Section title="Convergence" icon="📈" collapsible defaultOpen={false}>
          <DecisionTimeline
            items={timeline.map((r) => ({
              round: r.round,
              label: r.leader,
              value: r.best_cv,
              status: "success",
            }))}
          />
          {competitionTimeline?.convergence_round && (
            <div className="mt-2 text-[10px] text-center text-[var(--text-muted)]">
              Converged at round {competitionTimeline.convergence_round}
            </div>
          )}
        </Section>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <Section title="Recommendations" icon="💡" badge={recommendations.length}>
          <div className="space-y-2">
            {recommendations.map((rec, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="text-[var(--accent-blue)]">→</span>
                <span className="text-[var(--text-secondary)]">{rec}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

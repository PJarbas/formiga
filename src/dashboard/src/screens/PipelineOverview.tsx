// ══════════════════════════════════════════════════════════════════════
// PipelineOverview.tsx — Tela 1: run info + agent cards + quick stats
// ══════════════════════════════════════════════════════════════════════

import { usePipelineStatus, useAgents } from "../api/api";

export default function PipelineOverview() {
  const { data: status, isLoading, error } = usePipelineStatus();
  const { data: agents } = useAgents();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading pipeline status...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--accent-red)] bg-[var(--bg-secondary)] p-6 text-center">
        <p className="text-[var(--accent-red)] font-medium">Failed to load pipeline status</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (!status || status.status === "idle") {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center">
        <div className="text-4xl mb-4">🐜</div>
        <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">No Active Pipeline</h2>
        <p className="text-[var(--text-secondary)] max-w-md mx-auto">
          No ML pipeline is currently running. Start a Formiga pipeline to see
          live agent status, metrics, and leaderboard results.
        </p>
      </div>
    );
  }

  const phaseStats = status.phaseStats;
  const agentCards = [
    { key: "dataAnalyst", label: "Data Analyst", phase: "data_analysis", icon: "📊" },
    { key: "featureEngineer", label: "Feature Eng.", phase: "feature_engineering", icon: "🔧" },
    { key: "modelerClassic", label: "Classic ML", phase: "modeling", icon: "🤖" },
    { key: "modelerAdvanced", label: "Advanced ML", phase: "modeling", icon: "🧠" },
    { key: "mlCritic", label: "ML Critic", phase: "audit", icon: "🔍" },
  ] as const;

  return (
    <div className="space-y-6">
      {/* Run info header */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Run <code className="text-sm bg-[var(--bg-tertiary)] px-2 py-0.5 rounded">{status.runId}</code>
            </h2>
            <p className="text-[var(--text-secondary)] text-sm mt-1">
              Started {status.startedAt ? new Date(status.startedAt).toLocaleString() : "—"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className={`status-dot ${status.status}`} />
              <span className="text-sm font-medium capitalize text-[var(--text-primary)]">{status.status}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-4">
        {([
          { label: "Experiments", value: status.quickStats.totalExperiments },
          { label: "Best CV Mean", value: status.quickStats.bestCvMean?.toFixed(4) ?? "—" },
          { label: "Rounds", value: `${status.quickStats.roundsCompleted}/${status.maxRounds}` },
          { label: "Tokens", value: status.quickStats.tokensSpent.toLocaleString() },
        ] as const).map((stat) => (
          <div key={stat.label} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
            <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">{stat.label}</p>
            <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Agent cards */}
      <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide">Agents</h3>
      <div className="grid grid-cols-5 gap-4">
        {agentCards.map(({ key, label, icon }) => {
          const agentStatus = (phaseStats as Record<string, string>)[key];
          return (
            <div
              key={key}
              className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 hover:border-[var(--accent-blue)] transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">{icon}</span>
                <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={`status-dot ${agentStatus}`} />
                <span className="text-xs capitalize text-[var(--text-secondary)]">{agentStatus}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Current phase indicator */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide mb-2">Phase Progress</p>
        <div className="flex items-center gap-2">
          {["data_analysis", "feature_engineering", "modeling", "audit"].map((phase, i) => {
            const isActive = status.currentPhase === phase;
            const isDone =
              ["data_analysis", "feature_engineering", "modeling", "audit"].indexOf(status.currentPhase) > i;
            return (
              <div key={phase} className="flex items-center gap-2 flex-1">
                <div className={`flex-1 h-1.5 rounded-full ${isActive ? "bg-[var(--accent-blue)]" : isDone ? "bg-[var(--accent-green)]" : "bg-[var(--bg-tertiary)]"}`} />
                {i < 3 && <div className="w-2 h-2 rounded-full bg-[var(--border-default)]" />}
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-2">
          {["Data Analysis", "Feature Eng.", "Modeling", "Audit"].map((label) => (
            <span key={label} className="text-[10px] text-[var(--text-muted)]">{label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

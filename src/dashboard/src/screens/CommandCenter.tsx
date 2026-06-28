// ══════════════════════════════════════════════════════════════════════
// CommandCenter.tsx — Tela 1
// StatusCard + PipelineStepper + RoundsTable.
// Powered by GET /api/command-center (3s poll inside useCommandCenter).
// ══════════════════════════════════════════════════════════════════════

import { useCommandCenter } from "../api/api";
import { PipelineStepper } from "../components/PipelineStepper";
import { StatusCard } from "../components/StatusCard";
import { RoundsTable } from "../components/RoundsTable";
import { EmptyState } from "../components/EmptyState";
import { useHumanStatus } from "../hooks/useHumanStatus";

export default function CommandCenter() {
  const { data, isLoading, error } = useCommandCenter();
  const humanStatus = useHumanStatus();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading command center...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--accent-red)] bg-[var(--bg-secondary)] p-6 text-center">
        <p className="text-[var(--accent-red)] font-medium">Failed to load command center</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (!data || data.run.status === "idle") {
    return (
      <div
        data-testid="cc-idle"
        className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center"
      >
        <EmptyState
          icon="⚙️"
          message="No active pipeline"
          detail="Start a pipeline from the CLI to see rounds here."
        />
        <code className="inline-block text-xs font-mono text-[var(--accent-blue)] bg-[var(--bg-tertiary)] px-3 py-1.5 rounded mt-3">
          formiga run --task &quot;predict churn&quot; --rounds 5
        </code>
      </div>
    );
  }

  const { run, phases, rounds = [] } = data;

  return (
    <div className="space-y-6" data-testid="command-center">
      {humanStatus && (
        <StatusCard
          status={humanStatus}
          startedAt={run.startedAt}
          updatedAt={run.updatedAt}
        />
      )}

      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <PipelineStepper phases={phases} currentPhase={run.currentPhase} />
      </div>

      <RoundsTable
        rounds={rounds}
        currentRound={run.currentRound}
        runId={run.runId ?? ""}
      />
    </div>
  );
}

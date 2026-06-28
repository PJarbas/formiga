import { Link } from "react-router-dom";
import { getStatusConfig } from "../lib/status-config";
import { formatElapsedMs } from "../lib/format";
import { EmptyState } from "./EmptyState";
import type { RoundSummary, PipelinePhase } from "@shared/dashboard-types";

const PHASE_LABELS: Record<PipelinePhase, string> = {
  idle: "Initializing",
  data_analysis: "Data Analysis",
  feature_engineering: "Feature Engineering",
  modeling: "Modeling",
  audit: "Audit",
  complete: "Complete",
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface RoundsTableProps {
  rounds: RoundSummary[];
  currentRound: number;
  runId: string;
}

export function RoundsTable({ rounds, currentRound, runId }: RoundsTableProps) {
  if (rounds.length === 0) {
    return (
      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <EmptyState
          icon="⚙️"
          message="No rounds yet"
          detail="Pipeline will populate rounds as they progress."
          showProgress
        />
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Rounds</h3>
        <span className="text-xs text-[var(--text-muted)]">
          {rounds.filter((r) => r.status === "completed").length}/{rounds.length}
        </span>
      </div>
      <div className="space-y-2">
        {rounds.map((round) => (
          <RoundRow
            key={round.roundNumber}
            round={round}
            isActive={round.roundNumber === currentRound && round.status === "running"}
            runId={runId}
          />
        ))}
      </div>
    </section>
  );
}

function RoundRow({ round, isActive, runId }: { round: RoundSummary; isActive: boolean; runId: string }) {
  const config = getStatusConfig(round.status === "running" ? "running" : round.status === "failed" ? "failed" : "completed");
  const phaseLabel = round.currentPhase ? PHASE_LABELS[round.currentPhase] : null;

  return (
    <Link
      to={`/kanban?round=${round.roundNumber}`}
      className={[
        "block rounded-lg border p-4 transition-colors cursor-pointer",
        isActive
          ? "border-l-2 border-l-[var(--status-running)] border-[var(--border-default)] bg-[color-mix(in_srgb,var(--status-running)_5%,transparent)]"
          : "border-[var(--border-default)] hover:border-[var(--accent-blue)] hover:bg-[var(--bg-tertiary)]",
      ].join(" ")}
      data-testid={`round-row-${round.roundNumber}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${isActive ? "animate-pulse" : ""}`}
            style={{ backgroundColor: config.hex }}
            aria-label={config.label}
          />
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Round {round.roundNumber}
          </span>
          {phaseLabel && (
            <>
              <span className="text-[var(--text-muted)]" aria-hidden="true">&middot;</span>
              <span className="text-xs text-[var(--text-muted)]">{phaseLabel}</span>
            </>
          )}
        </div>

        {round.bestCvMean != null && (
          <span className="text-xs font-mono text-[var(--accent-green)] shrink-0">
            CV {round.bestCvMean.toFixed(4)}
          </span>
        )}
        {round.bestCvMean == null && round.status === "failed" && (
          <span className="text-xs text-[var(--accent-red)]">Failed</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 mt-1.5 ml-5 flex-wrap">
        <span className="text-xs text-[var(--text-muted)]">
          {round.totalExperiments} experiment{round.totalExperiments !== 1 ? "s" : ""}
        </span>
        {round.durationMs != null && (
          <>
            <span className="text-[var(--text-muted)]" aria-hidden="true">&middot;</span>
            <span className="text-xs text-[var(--text-muted)]">{formatElapsedMs(round.durationMs)}</span>
          </>
        )}
        {isActive && round.startedAt && (
          <>
            <span className="text-[var(--text-muted)]" aria-hidden="true">&middot;</span>
            <span className="text-xs text-[var(--text-muted)]">Running...</span>
          </>
        )}
        {!isActive && round.completedAt && (
          <>
            <span className="text-[var(--text-muted)]" aria-hidden="true">&middot;</span>
            <span className="text-xs text-[var(--text-muted)]">{formatRelativeTime(round.completedAt)}</span>
          </>
        )}
      </div>
    </Link>
  );
}

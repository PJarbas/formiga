import { Link } from "react-router-dom";
import { getStatusConfig } from "../lib/status-config";
import { formatElapsedMs, formatElapsedBetween } from "../lib/format";
import { EmptyState } from "./EmptyState";
import type { RoundSummary, PhaseInfo } from "@shared/dashboard-types";

// ── Helpers ──────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Atoms ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const normalized = status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
  const config = getStatusConfig(normalized);

  return (
    <div className="flex flex-col items-center gap-0.5 w-14 shrink-0">
      <svg width="16" height="16" viewBox="0 0 16 16" className={normalized === "running" ? "animate-pulse" : ""}>
        <circle cx="8" cy="8" r="7" fill={config.hex} />
        {normalized === "completed" && (
          <path d="M4.5 8.5L7 11L11.5 5.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {normalized === "failed" && (
          <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
        )}
      </svg>
      <span className="text-[10px] leading-none" style={{ color: `var(${config.colorVar})` }}>
        {normalized === "completed" ? "passed" : normalized}
      </span>
    </div>
  );
}

function StageDots({ phases, roundStatus }: { phases: PhaseInfo[]; roundStatus: string }) {
  const dots = phases.map((phase) => {
    if (roundStatus === "completed") return "done" as const;
    if (roundStatus === "failed") {
      if (phase.status === "done") return "done" as const;
      if (phase.status === "failed") return "failed" as const;
      return "pending" as const;
    }
    return phase.status as "done" | "running" | "pending" | "failed";
  });

  return (
    <div className="flex items-center gap-1">
      {dots.map((dot, i) => {
        const config = getStatusConfig(
          dot === "done" ? "completed" : dot === "running" ? "running" : dot === "failed" ? "failed" : "idle",
        );
        return (
          <svg
            key={phases[i]?.id ?? i}
            width="14"
            height="14"
            viewBox="0 0 14 14"
            className={dot === "running" ? "animate-pulse" : ""}
            aria-label={phases[i]?.label}
          >
            {dot === "pending" ? (
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--border-default)" strokeWidth="1.5" />
            ) : (
              <>
                <circle cx="7" cy="7" r="6" fill={config.hex} />
                {dot === "done" && (
                  <path d="M4 7.2L6 9.2L10 4.8" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                )}
                {dot === "failed" && (
                  <path d="M5 5L9 9M9 5L5 9" stroke="white" strokeWidth="1.3" strokeLinecap="round" />
                )}
              </>
            )}
          </svg>
        );
      })}
    </div>
  );
}

// ── Molecule ─────────────────────────────────────────────────────────

function RoundRow({ round, isActive, phases }: { round: RoundSummary; isActive: boolean; phases: PhaseInfo[] }) {
  return (
    <Link
      to={`/kanban?round=${round.roundNumber}`}
      data-testid={`round-row-${round.roundNumber}`}
      className={[
        "flex items-center gap-4 px-5 py-3 transition-colors",
        isActive
          ? "bg-[color-mix(in_srgb,var(--status-running)_5%,transparent)]"
          : "hover:bg-[var(--bg-tertiary)]",
      ].join(" ")}
    >
      <StatusBadge status={round.status} />

      <div className="min-w-[80px]">
        <span className="text-sm font-medium text-[var(--text-primary)]">Round {round.roundNumber}</span>
        {isActive && round.currentPhase && (
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            {round.currentPhase.replace(/_/g, " ")}
          </p>
        )}
      </div>

      <StageDots phases={phases} roundStatus={round.status} />

      <div className="ml-auto flex items-center gap-4 text-xs text-[var(--text-muted)]">
        <span>
          {round.totalExperiments} exp{round.totalExperiments !== 1 ? "s" : ""}
        </span>
        {round.bestCvMean != null && (
          <span className="font-mono text-[var(--accent-green)]">
            CV {round.bestCvMean.toFixed(4)}
          </span>
        )}
        <span className="font-mono w-14 text-right">
          {round.durationMs != null ? formatElapsedMs(round.durationMs) : isActive ? "..." : "—"}
        </span>
        {!isActive && round.completedAt && (
          <span className="w-14 text-right">{formatRelativeTime(round.completedAt)}</span>
        )}
      </div>
    </Link>
  );
}

// ── Organism ─────────────────────────────────────────────────────────

export interface RoundsTableProps {
  rounds: RoundSummary[];
  currentRound: number;
  runId: string;
  phases: PhaseInfo[];
  startedAt: string | null;
  updatedAt: string | null;
}

export function RoundsTable({ rounds, currentRound, phases, startedAt, updatedAt }: RoundsTableProps) {
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
    <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Pipeline Runs</h3>
        <span className="text-xs font-mono text-[var(--text-muted)]">
          {formatElapsedBetween(startedAt, updatedAt)}
        </span>
      </div>
      <div className="divide-y divide-[var(--border-default)]">
        {rounds.map((round) => (
          <RoundRow
            key={round.roundNumber}
            round={round}
            isActive={round.roundNumber === currentRound && round.status === "running"}
            phases={phases}
          />
        ))}
      </div>
    </section>
  );
}

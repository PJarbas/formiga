import { Link } from "react-router-dom";
import { getStatusConfig } from "../lib/status-config";
import { formatElapsedMs } from "../lib/format";
import { EmptyState } from "./EmptyState";
import type { PipelineRunRow } from "@shared/dashboard-types";

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

function StageDots({ phases }: { phases: PipelineRunRow["phases"] }) {
  return (
    <div className="flex items-center gap-1">
      {phases.map((phase) => {
        const config = getStatusConfig(
          phase.status === "done" ? "completed" : phase.status === "running" ? "running" : phase.status === "failed" ? "failed" : "idle",
        );
        return (
          <svg
            key={phase.id}
            width="14"
            height="14"
            viewBox="0 0 14 14"
            className={phase.status === "running" ? "animate-pulse" : ""}
            aria-label={phase.label}
          >
            {phase.status === "pending" ? (
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--border-default)" strokeWidth="1.5" />
            ) : (
              <>
                <circle cx="7" cy="7" r="6" fill={config.hex} />
                {phase.status === "done" && (
                  <path d="M4 7.2L6 9.2L10 4.8" stroke="white" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                )}
                {phase.status === "failed" && (
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

function RunRow({ run }: { run: PipelineRunRow }) {
  const isActive = run.status === "running" || run.status === "paused";

  return (
    <Link
      to={`/kanban?run=${run.runId}`}
      data-testid={`run-row-${run.shortHash}`}
      className={[
        "flex items-center gap-4 px-5 py-3 transition-colors",
        isActive
          ? "bg-[color-mix(in_srgb,var(--status-running)_5%,transparent)]"
          : "hover:bg-[var(--bg-tertiary)]",
      ].join(" ")}
    >
      <StatusBadge status={run.status} />

      <div className="min-w-[140px] shrink-0">
        <span className="text-sm font-mono font-medium text-[var(--accent-blue)]">{run.shortHash}</span>
        {isActive && run.currentPhase !== "idle" && (
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            {run.currentPhase.replace(/_/g, " ")}
          </p>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--text-primary)] truncate">{run.task}</p>
      </div>

      <StageDots phases={run.phases} />

      <div className="ml-auto flex items-center gap-4 text-xs text-[var(--text-muted)] shrink-0">
        <span>
          {run.totalExperiments} exp{run.totalExperiments !== 1 ? "s" : ""}
        </span>
        {run.bestCvMean != null && (
          <span className="font-mono text-[var(--accent-green)]">
            CV {run.bestCvMean.toFixed(4)}
          </span>
        )}
        <span className="font-mono w-14 text-right">
          {run.durationMs != null ? formatElapsedMs(run.durationMs) : isActive ? "..." : "—"}
        </span>
        {!isActive && run.updatedAt && (
          <span className="w-14 text-right">{formatRelativeTime(run.updatedAt)}</span>
        )}
      </div>
    </Link>
  );
}

// ── Organism ─────────────────────────────────────────────────────────

export interface PipelineTableProps {
  runs: PipelineRunRow[];
}

export function PipelineTable({ runs }: PipelineTableProps) {
  if (runs.length === 0) {
    return (
      <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <EmptyState
          icon="⚙️"
          message="No pipeline runs"
          detail="Start a pipeline from the CLI to see runs here."
          showProgress
        />
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Pipeline Runs</h3>
        <span className="text-xs text-[var(--text-muted)]">
          {runs.filter((r) => r.status === "running").length} active
        </span>
      </div>
      <div className="divide-y divide-[var(--border-default)]">
        {runs.map((run) => (
          <RunRow key={run.runId} run={run} />
        ))}
      </div>
    </section>
  );
}

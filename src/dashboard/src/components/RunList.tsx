import { Link } from "react-router-dom";
import { formatElapsedMs } from "../lib/format";
import { EmptyState } from "./EmptyState";
import type { PipelineRunRow, PhaseInfo } from "@shared/dashboard-types";

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

/** Normalize a run status to the visual states the list understands. */
function normalizeStatus(status: string): "running" | "passed" | "failed" | "paused" {
  if (status === "completed") return "passed";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  return "running";
}

export type RunActionId = "pause" | "resume" | "cancel" | "delete";

// ── Atoms ────────────────────────────────────────────────────────────

/** Circular status icon — running pulse, failed X, passed check, paused bars. */
function StatusIcon({ status }: { status: string }) {
  const normalized = normalizeStatus(status);

  const container =
    "h-8 w-8 rounded-full flex items-center justify-center shrink-0";

  switch (normalized) {
    case "running":
      return (
        <div
          className={`${container} bg-blue-500/10`}
          aria-label="Status: running"
          title="Running"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-blue-500 animate-ping opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
          </span>
        </div>
      );
    case "failed":
      return (
        <div
          className={`${container} bg-red-500/10`}
          aria-label="Status: failed"
          title="Failed"
        >
          <svg className="h-4 w-4 text-red-400" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
      );
    case "paused":
      return (
        <div
          className={`${container} bg-amber-500/10`}
          aria-label="Status: paused"
          title="Paused"
        >
          <svg className="h-4 w-4 text-amber-400" viewBox="0 0 16 16" fill="currentColor">
            <rect x="4.5" y="4" width="2.5" height="8" rx="1" />
            <rect x="9" y="4" width="2.5" height="8" rx="1" />
          </svg>
        </div>
      );
    default:
      return (
        <div
          className={`${container} bg-green-500/10`}
          aria-label="Status: passed"
          title="Passed"
        >
          <svg className="h-4 w-4 text-green-400" viewBox="0 0 16 16" fill="none">
            <path d="M4 8.5L6.5 11L12 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      );
  }
}

/** Compact workflow/arena tag next to the run id. */
function RunTag({ children }: { children: string }) {
  return (
    <span className="text-[10px] font-medium text-gray-400 bg-gray-800/70 rounded px-1.5 py-0.5 leading-none">
      {children}
    </span>
  );
}

/** Parse a `key=value ...` task string into chips with the key muted and value bright. */
function ParamChips({ task }: { task: string }) {
  const tokens = task.split(/\s+/).filter(Boolean);

  return (
    <div
      data-testid="param-chips"
      className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden [mask-image:linear-gradient(to_right,black_85%,transparent)]"
    >
      {tokens.map((token) => {
        const eq = token.indexOf("=");
        if (eq === -1) {
          return (
            <span
              key={token}
              className="bg-white/[0.04] rounded px-1.5 py-0.5 font-mono text-[11px] text-gray-400 whitespace-nowrap shrink-0"
            >
              {token}
            </span>
          );
        }
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        return (
          <span
            key={token}
            className="bg-white/[0.04] rounded px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap shrink-0"
          >
            <span className="text-gray-400">{key}=</span>
            <span className="text-white">{value}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Segmented progress bar (GitHub Actions style) — one pill per phase. */
function StepTracker({
  phases,
  arenaProgress,
  currentPhase,
}: {
  phases: PhaseInfo[];
  arenaProgress?: PipelineRunRow["arenaProgress"];
  currentPhase: string;
}) {
  const isArenaRunning =
    arenaProgress?.status === "running" && currentPhase === "arena";

  return (
    <div className="flex items-center gap-2 shrink-0" title="Pipeline phases">
      <div
        className="flex h-1.5 w-36 gap-0.5 rounded-full shrink-0"
        data-testid="step-tracker"
      >
        {phases.map((phase) => {
          const cls =
            phase.status === "done"
              ? "bg-emerald-500"
              : phase.status === "running"
                ? "bg-blue-500 animate-pulse"
                : phase.status === "failed"
                  ? "bg-red-500"
                  : "bg-gray-800";
          return (
            <span
              key={phase.id}
              data-status={phase.status}
              title={phase.label}
              className={`flex-1 rounded-full ${cls}`}
            />
          );
        })}
      </div>
      {isArenaRunning && arenaProgress && (
        <span className="text-[10px] font-mono text-gray-500">
          R{arenaProgress.currentRound}/{arenaProgress.maxRounds}
        </span>
      )}
    </div>
  );
}

function RunActions({
  status,
  onAction,
}: {
  status: string;
  onAction: (action: RunActionId) => void;
}) {
  const actions: Array<{ id: RunActionId; title: string; icon: JSX.Element; variant: string }> = [];

  if (status === "running") {
    actions.push({
      id: "pause",
      title: "Pause",
      variant: "text-[var(--accent-orange)]",
      icon: <path d="M5 3h2v10H5zM9 3h2v10H9z" fill="currentColor" />,
    });
  }
  if (status === "paused") {
    actions.push({
      id: "resume",
      title: "Resume",
      variant: "text-[var(--accent-green)]",
      icon: <path d="M5 3l9 5-9 5z" fill="currentColor" />,
    });
  }
  if (status === "running" || status === "paused") {
    actions.push({
      id: "cancel",
      title: "Cancel",
      variant: "text-[var(--accent-red)]",
      icon: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
    });
  }
  actions.push({
    id: "delete",
    title: "Delete",
    variant: "text-[var(--text-muted)] hover:text-[var(--accent-red)]",
    icon: <path d="M5 3v-1h6v1h3v1.5H2V3h3zM3.5 5.5h9l-.7 8.5H4.2z" fill="currentColor" />,
  });

  return (
    <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0">
      {actions.map((a) => (
        <button
          key={a.id}
          title={a.title}
          data-testid={`run-action-${a.id}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAction(a.id);
          }}
          className={`p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors ${a.variant}`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16">{a.icon}</svg>
        </button>
      ))}
    </div>
  );
}

// ── Molecule ─────────────────────────────────────────────────────────

function RunRow({
  run,
  onAction,
}: {
  run: PipelineRunRow;
  onAction?: (runId: string, action: RunActionId) => void;
}) {
  const isActive = run.status === "running" || run.status === "paused";
  const workflowLabel = run.workflowType === "ml-autoresearch" ? "autoresearch" : "pipeline";
  const duration = run.durationMs != null ? formatElapsedMs(run.durationMs) : isActive ? "..." : "—";

  return (
    <Link
      to={`/kanban?run=${run.runId}`}
      data-testid={`run-row-${run.shortHash}`}
      className={[
        "group/row flex items-center gap-4 px-5 py-3 transition-colors hover:bg-gray-800/50",
        isActive
          ? "bg-[color-mix(in_srgb,var(--status-running)_5%,transparent)]"
          : "",
      ].join(" ")}
    >
      <StatusIcon status={run.status} />

      <div className="min-w-[140px] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-mono font-medium text-[var(--accent-blue)]">{run.shortHash}</span>
          <RunTag>{workflowLabel}</RunTag>
          {run.arenaProgress && <RunTag>arena</RunTag>}
        </div>
        {isActive && run.currentPhase !== "idle" && (
          <p className="text-[10px] text-gray-500 mt-0.5">
            {run.currentPhase.replace(/_/g, " ")}
          </p>
        )}
      </div>

      <ParamChips task={run.task} />

      <StepTracker phases={run.phases} arenaProgress={run.arenaProgress} currentPhase={run.currentPhase} />

      <div className="ml-auto flex items-center gap-4 text-xs shrink-0">
        <span className="text-gray-500">
          {run.totalExperiments} exp{run.totalExperiments !== 1 ? "s" : ""}
        </span>
        {run.bestCvMean != null && (
          <span className="font-mono font-semibold text-emerald-400">
            CV {run.bestCvMean.toFixed(4)}
          </span>
        )}
        <div className="flex flex-col items-end gap-0.5 w-16 shrink-0">
          <span className="font-mono text-gray-400">{duration}</span>
          {!isActive && run.updatedAt && (
            <span className="text-[11px] text-gray-500">{formatRelativeTime(run.updatedAt)}</span>
          )}
        </div>
      </div>

      {onAction && (
        <RunActions
          status={run.status}
          onAction={(action) => onAction(run.runId, action)}
        />
      )}
    </Link>
  );
}

// ── Organism ─────────────────────────────────────────────────────────

export interface RunListProps {
  runs: PipelineRunRow[];
  onRunAction?: (runId: string, action: RunActionId) => void;
}

export function RunList({ runs, onRunAction }: RunListProps) {
  if (runs.length === 0) {
    return (
      <section className="rounded-xl border border-gray-800 bg-[var(--bg-secondary)] p-5">
        <EmptyState
          icon="⚙️"
          message="No pipeline runs"
          detail="Start a pipeline from the CLI to see runs here."
          showProgress
        />
      </section>
    );
  }

  const activeCount = runs.filter((r) => r.status === "running").length;

  return (
    <section className="rounded-xl border border-gray-800 bg-[var(--bg-secondary)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Runs</h3>
        <span className="text-xs text-gray-400">{activeCount} active</span>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {runs.map((run) => (
          <RunRow key={run.runId} run={run} onAction={onRunAction} />
        ))}
      </div>
    </section>
  );
}

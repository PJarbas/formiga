import { useState } from "react";
import { useArenaControls } from "../../api/api";
import type { ArenaDashboardStatus } from "@shared/dashboard-types";
import { getStatusConfig } from "../../lib/status-config";

interface ArenaControlsBarProps {
  runId: string;
  status: ArenaDashboardStatus;
}

type ControlAction = "pause" | "resume" | "skip" | "stop";

const ACTION_META: Record<ControlAction, { label: string; variant: "default" | "danger" }> = {
  pause: { label: "Pause", variant: "default" },
  resume: { label: "Resume", variant: "default" },
  skip: { label: "Skip Round", variant: "default" },
  stop: { label: "Stop Arena", variant: "danger" },
};

export default function ArenaControlsBar({ runId, status }: ArenaControlsBarProps) {
  const control = useArenaControls(runId);
  const [pendingAction, setPendingAction] = useState<ControlAction | null>(null);
  const statusConfig = getStatusConfig(status);

  const isRunning = status === "running";
  const canPause = isRunning;
  const canResume = status === "paused";
  const canStop = status === "running" || status === "paused";
  const canSkip = isRunning;

  function onClick(action: ControlAction) {
    setPendingAction(action);
    control.mutate(
      { action },
      {
        onSettled: () => setPendingAction(null),
      },
    );
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-3">
      <div className="flex items-center gap-2">
        <div aria-label={`Arena status: ${status}`} title={`Arena status: ${status}`}>
          <span className="text-lg">{statusConfig.emoji}</span>
        </div>
        <span className="text-sm font-medium text-[var(--text-primary)]">
          Arena — <span className="text-[var(--text-secondary)]">{statusConfig.label}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        {(canPause || canResume) && (
          <button
            type="button"
            disabled={control.isPending}
            onClick={() => onClick(canResume ? "resume" : "pause")}
            className="text-sm rounded px-3 py-1.5 border border-[var(--status-running)] text-[var(--text-primary)] hover:bg-[var(--status-running)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {control.isPending && pendingAction === (canResume ? "resume" : "pause") ? "…" : ACTION_META[canResume ? "resume" : "pause"].label}
          </button>
        )}
        {canSkip && (
          <button
            type="button"
            disabled={control.isPending}
            onClick={() => onClick("skip")}
            className="text-sm rounded px-3 py-1.5 border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {control.isPending && pendingAction === "skip" ? "…" : ACTION_META["skip"].label}
          </button>
        )}
        {canStop && (
          <button
            type="button"
            disabled={control.isPending}
            onClick={() => {
              if (!window.confirm("Stop the arena competition? This will end the current run."))
                return;
              onClick("stop");
            }}
            className="text-sm rounded px-3 py-1.5 bg-[var(--status-failed)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {control.isPending && pendingAction === "stop" ? "…" : ACTION_META["stop"].label}
          </button>
        )}
      </div>
    </div>
  );
}

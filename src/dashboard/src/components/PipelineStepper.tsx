// ══════════════════════════════════════════════════════════════════════
// PipelineStepper.tsx — Horizontal dots + connectors per phase
// ══════════════════════════════════════════════════════════════════════

import type { PhaseInfo } from "@shared/dashboard-types";

export interface PipelineStepperProps {
  phases: PhaseInfo[];
  currentPhase: string;
}

const STATUS_COLOR: Record<PhaseInfo["status"], string> = {
  done: "var(--accent-green)",
  running: "var(--accent-blue)",
  pending: "var(--text-muted)",
  failed: "var(--accent-red)",
};

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export function PipelineStepper({ phases, currentPhase }: PipelineStepperProps) {
  if (phases.length === 0) {
    return (
      <div data-testid="stepper-empty" className="text-sm text-[var(--text-muted)] italic">
        No phases configured.
      </div>
    );
  }

  return (
    <div data-testid="pipeline-stepper" className="flex items-start">
      {phases.map((p, idx) => {
        const isCurrent = p.id === currentPhase;
        const color = STATUS_COLOR[p.status];
        return (
          <div key={p.id} className="flex items-start flex-1 min-w-0">
            <div className="flex flex-col items-center min-w-0 flex-1">
              <div
                data-testid={`phase-dot-${p.id}`}
                data-status={p.status}
                className={`inline-flex items-center justify-center rounded-full ${
                  isCurrent && p.status === "running" ? "animate-pulse" : ""
                }`}
                style={{
                  width: 20,
                  height: 20,
                  background: color,
                  boxShadow: isCurrent ? `0 0 0 4px color-mix(in srgb, ${color} 25%, transparent)` : undefined,
                }}
              />
              <div className="mt-2 text-xs font-medium text-[var(--text-primary)] truncate w-full text-center">
                {p.label}
              </div>
              <div className="mt-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                {formatElapsed(p.elapsedMs)}
              </div>
            </div>
            {idx < phases.length - 1 && (
              <div
                aria-hidden
                className="h-px mt-2.5 flex-1"
                style={{
                  background:
                    p.status === "done" ? "var(--accent-green)" : "var(--border-default)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

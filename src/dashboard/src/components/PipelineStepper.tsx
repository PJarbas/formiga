// ══════════════════════════════════════════════════════════════════════
// PipelineStepper.tsx — Horizontal phase progress stepper
// ══════════════════════════════════════════════════════════════════════
// Consumes STATUS_CONFIG for all visual decisions. Uses formatElapsedMs
// from lib/format. No hardcoded colors or emoji.
// ══════════════════════════════════════════════════════════════════════

import type { PhaseInfo } from "@shared/dashboard-types";
import { getStatusConfig } from "../lib/status-config.js";
import { formatElapsedMs } from "../lib/format.js";

export interface PipelineStepperProps {
  phases: PhaseInfo[];
  currentPhase: string;
}

const PHASE_STATUS_TO_UI: Record<PhaseInfo["status"], "completed" | "running" | "pending" | "failed"> = {
  done: "completed",
  running: "running",
  pending: "pending",
  failed: "failed",
};

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
        const uiStatus = PHASE_STATUS_TO_UI[p.status];
        const config = getStatusConfig(uiStatus);

        return (
          <div key={p.id} className="flex items-start flex-1 min-w-0">
            <div className="flex flex-col items-center min-w-0 flex-1 relative">
              {/* Running-phase background highlight */}
              {isCurrent && p.status === "running" && (
                <div className="absolute inset-0 -m-3 rounded-lg bg-[var(--status-running)]/5 -z-10" />
              )}
              <div
                data-testid={`phase-dot-${p.id}`}
                data-status={p.status}
                className={`inline-flex items-center justify-center text-sm ${
                  isCurrent && p.status === "running" ? "animate-pulse" : ""
                }`}
                style={{
                  width: 24,
                  height: 24,
                  color: `var(${config.colorVar})`,
                }}
              >
                {config.emoji}
              </div>
              <div className="mt-2 text-xs font-medium text-[var(--text-primary)] truncate w-full text-center">
                {p.label}
              </div>
              <div className="mt-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                {formatElapsedMs(p.elapsedMs)}
              </div>
            </div>
            {idx < phases.length - 1 && (
              <div
                aria-hidden
                className="h-px mt-3 flex-1"
                style={{
                  background: p.status === "done"
                    ? "var(--status-completed)"
                    : p.status === "running"
                      ? "var(--status-running)"
                      : "var(--border-default)",
                  borderStyle: p.status === "pending" ? "dashed" : undefined,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
// ══════════════════════════════════════════════════════════════════════
// useHumanStatus.ts — Composable hook that derives HumanStatus from pipeline data
// ══════════════════════════════════════════════════════════════════════

import { usePipelineStatus } from "../api/api.js";
import { getHumanStatus, type HumanStatus } from "../lib/human-status.js";

/** Derives HumanStatus from live pipeline data. Returns null when data is loading. */
export function useHumanStatus(): HumanStatus | null {
  const { data: pipeline } = usePipelineStatus();

  if (!pipeline) return null;

  return getHumanStatus({
    status: pipeline.status,
    currentPhase: pipeline.currentPhase,
    currentRound: pipeline.currentRound,
    maxRounds: pipeline.maxRounds,
    pendingDecisions: 0,
  });
}
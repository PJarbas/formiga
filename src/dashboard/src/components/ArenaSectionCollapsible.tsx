// ══════════════════════════════════════════════════════════════════════
// ArenaSectionCollapsible.tsx — Accordion for arena data in leaderboard
// Only renders when isArenaRun is true
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import type { ArenaSessionResponse, ArenaConvergenceResponse, ArenaConfidenceResponse, ArenaRoundResponse } from "@shared/dashboard-types";
import ConvergenceChart from "./arena/ConvergenceChart";
import ConfidenceStats from "./arena/ConfidenceStats";
import AgentStrategyCards from "./arena/AgentStrategyCards";

interface ArenaSectionCollapsibleProps {
  session: ArenaSessionResponse | undefined;
  convergence: ArenaConvergenceResponse | undefined;
  confidence: ArenaConfidenceResponse | undefined;
  rounds: ArenaRoundResponse[] | undefined;
}

export function ArenaSectionCollapsible({ session, convergence, confidence, rounds }: ArenaSectionCollapsibleProps) {
  const [open, setOpen] = useState(false);

  if (!session) return null;

  return (
    <div className="border border-[var(--border-default)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors text-left"
      >
        <span className="text-sm font-medium text-[var(--text-primary)]">
          {open ? "▼" : "▶"} Arena Session · Round {session.currentRound}/{session.maxRounds} · {session.status}
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {session.bestMetric != null ? `Best: ${session.bestMetric.toFixed(4)}` : "No results yet"}
        </span>
      </button>

      {open && (
        <div className="p-4 space-y-4 bg-[var(--bg-secondary)]">
          <ConfidenceStats confidence={confidence} session={session} />
          <ConvergenceChart
            points={convergence?.points ?? []}
            confidence={confidence}
            maxRounds={session.maxRounds}
          />
          <AgentStrategyCards rounds={rounds ?? []} />
        </div>
      )}
    </div>
  );
}
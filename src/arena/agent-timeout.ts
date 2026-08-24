// ══════════════════════════════════════════════════════════════════════
// agent-timeout.ts — Dynamic timeouts for arena agent generation
// ══════════════════════════════════════════════════════════════════════
//
// The arena modelers do not just write a script: they explore (run
// experiments, train folds, wait on `sleep`-guarded background jobs) before
// producing the final script. A single fixed wall-clock timeout is the wrong
// model:
//   - On LARGE datasets (millions of rows) a healthy exploration phase
//     routinely exceeds 30 min — run e5cccd51 killed actively-training
//     modelers at exactly 1800s, losing a tweedie result 1.2 RMSE better
//     than baseline.
//   - On TINY datasets the same 30 min lets a truly stuck agent burn budget
//     for half an hour.
//
// The dynamic model uses TWO independent bounds (see activity-timeout.ts):
//   - hard cap: absolute wall-clock ceiling, tier-aware and scaled by the
//     compute budget's max_fit_seconds. Never re-armed.
//   - stale: when the agent stops producing ANY output (tool calls / stream)
//     for this long, it is stuck — kill. Re-armed on every output.
//
// Env knobs (seconds):
//   FORMIGA_ARENA_AGENT_TIMEOUT         hard cap fallback/override, default 7200 (2h)
//   FORMIGA_ARENA_AGENT_STALE_SECONDS   stale threshold, default 1200 (20 min)
//
// Pure module — no imports beyond Node types, fully unit-testable.
// ══════════════════════════════════════════════════════════════════════

/** Absolute wall-clock ceilings per complexity tier (seconds). */
export const AGENT_TIMEOUT_HARD_CAP_BY_TIER: Record<string, number> = {
  TINY: 600,    // 10 min
  SMALL: 1200,  // 20 min
  MEDIUM: 2400, // 40 min
  LARGE: 3600,  // 60 min
};

/** Fallback defaults (seconds) used when the env vars are unset/invalid. */
export const AGENT_TIMEOUT_HARD_CAP_DEFAULT_SECONDS = 7200;
export const AGENT_TIMEOUT_STALE_DEFAULT_SECONDS = 1200;

/** Multiplier applied to compute_budget.max_fit_seconds for exploration headroom. */
const BUDGET_HEADROOM_FACTOR = 4;

export interface AgentTimeoutBudget {
  /** Absolute wall-clock cap (ms). The harness never lets the agent run past this. */
  hardTimeoutMs: number;
  /** Idle threshold (ms): no output for this long ⇒ agent is stuck and killed. */
  staleTimeoutMs: number;
}

/** Structural input — anything carrying max_fit_seconds works (ComputeBudget fits). */
export interface AgentBudgetInput {
  maxFitSeconds: number;
}

function envSeconds(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the dynamic agent-generation timeout for a round.
 *
 * `tier` selects the tier base; `budget` (the enforceable compute budget,
 * which may come from benchmark_config.json) scales it up so a dataset whose
 * fit takes 15 min gets a proportionally larger exploration window. Both are
 * clamped to the global hard cap (FORMIGA_ARENA_AGENT_TIMEOUT).
 */
export function resolveAgentTimeout(
  tier: string,
  budget?: AgentBudgetInput | null,
): AgentTimeoutBudget {
  const tierKey = (tier ?? "medium").toUpperCase();
  const tierCap = AGENT_TIMEOUT_HARD_CAP_BY_TIER[tierKey] ?? AGENT_TIMEOUT_HARD_CAP_BY_TIER.MEDIUM;
  const budgetScaled = budget && budget.maxFitSeconds > 0
    ? budget.maxFitSeconds * BUDGET_HEADROOM_FACTOR
    : 0;
  const desired = Math.max(tierCap, budgetScaled);
  const hardSeconds = Math.max(
    60,
    Math.min(desired, envSeconds("FORMIGA_ARENA_AGENT_TIMEOUT", AGENT_TIMEOUT_HARD_CAP_DEFAULT_SECONDS)),
  );
  return {
    hardTimeoutMs: hardSeconds * 1000,
    staleTimeoutMs: envSeconds("FORMIGA_ARENA_AGENT_STALE_SECONDS", AGENT_TIMEOUT_STALE_DEFAULT_SECONDS) * 1000,
  };
}

// ══════════════════════════════════════════════════════════════════════
// query-arena.ts — Handler for query_arena MCP tool
// ══════════════════════════════════════════════════════════════════════

import type { ToolSchema, ToolContext, IArenaService } from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

/** Allowlist of valid views — validated against this, not a blocklist. */
const VALID_VIEWS = ["session", "rounds", "convergence"] as const;
type ArenaView = (typeof VALID_VIEWS)[number];

interface QueryArenaArgs {
  view: ArenaView;
}

/**
 * Handler for query_arena tool — read-only access to the arena competition
 * state. The read counterpart for competition data that the dashboard exposes
 * via /api/arena/:runId/{session,rounds,convergence}.
 *
 * Three views:
 *   - "session":     competition-level state (best metric, rounds, convergence counters)
 *   - "rounds":      all experiments grouped by round
 *   - "convergence": time-ordered series of every measured metric point
 *
 * Synchronous (not fire-and-forget) — the agent (reporter) needs the data to
 * write the final report.
 */
export class QueryArenaHandler extends BaseToolHandler {
  readonly name = "query_arena";

  readonly schema: ToolSchema = {
    name: "query_arena",
    description:
      "Read the arena competition state for the current run. Pass `view` to select the data: " +
      "'session' (best metric, rounds, convergence counters), 'rounds' (all experiments grouped " +
      "by round), or 'convergence' (time-ordered metric series). Use this instead of curl against " +
      "the arena API endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: [...VALID_VIEWS],
          description: "Which arena view to return: 'session', 'rounds', or 'convergence'.",
        },
      },
      required: ["view"],
    },
  };

  constructor(private readonly arenaService: IArenaService) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { view } = (args ?? {}) as Partial<QueryArenaArgs>;

    if (view === undefined) {
      throw new Error("Missing required field: view");
    }
    if (!VALID_VIEWS.includes(view)) {
      throw new Error(
        `Invalid view: "${view}". Must be one of: ${VALID_VIEWS.join(", ")}.`,
      );
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { view } = args as QueryArenaArgs;

    switch (view) {
      case "session":
        return this.formatSession(context.runId);
      case "rounds":
        return this.formatRounds(context.runId);
      case "convergence":
        return this.formatConvergence(context.runId);
    }
  }

  private async formatSession(runId: string): Promise<string> {
    const session = await this.arenaService.getSession(runId);
    if (!session) {
      return `No arena session found for run "${runId}".`;
    }
    const dir = session.metricDirection === "lower" ? "lower is better" : "higher is better";
    return [
      `Arena session (status: ${session.status}):`,
      `  Metric: ${session.metricName} (${dir})`,
      `  Best: ${session.bestMetric ?? "N/A"} by ${session.bestAgent ?? "N/A"}`,
      `  Baseline: ${session.baselineMetric ?? "N/A"}  Target: ${session.targetMetric ?? "none"}`,
      `  Round: ${session.currentRound}/${session.maxRounds}  (no-improve streak: ${session.consecutiveNoImprove})`,
      `  Totals: keep=${session.totalKeep} discard=${session.totalDiscard} crash=${session.totalCrash}`,
    ].join("\n");
  }

  private async formatRounds(runId: string): Promise<string> {
    const rounds = await this.arenaService.getRounds(runId);
    if (rounds.length === 0) {
      return "No arena rounds found for this run yet.";
    }
    const lines = rounds.map((r) => {
      const exps = r.experiments
        .map((e) => `    - ${e.agentName} (${e.modelType}): ${e.metric?.toFixed(6) ?? "fail"} [${e.decision ?? e.status}]`)
        .join("\n");
      return `  Round ${r.round} (${r.experiments.length} experiments):\n${exps}`;
    });
    return `Arena rounds (${rounds.length}):\n${lines.join("\n")}`;
  }

  private async formatConvergence(runId: string): Promise<string> {
    const points = await this.arenaService.getConvergence(runId);
    if (points.length === 0) {
      return "No convergence points found for this run yet.";
    }
    const lines = points.map(
      (p) => `  R${p.round} ${p.agent}: ${p.metric.toFixed(6)} [${p.decision ?? "-"}]`,
    );
    return `Convergence series (${points.length} points):\n${lines.join("\n")}`;
  }
}

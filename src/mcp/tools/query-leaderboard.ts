// ══════════════════════════════════════════════════════════════════════
// query-leaderboard.ts — Handler for query_leaderboard MCP tool
// ══════════════════════════════════════════════════════════════════════

import type {
  ToolSchema,
  ToolContext,
  ILeaderboardService,
  LeaderboardEntry,
} from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

interface QueryLeaderboardArgs {
  limit?: number;
}

/**
 * Handler for query_leaderboard tool.
 * Returns current competition state to inform model selection decisions.
 *
 * NOTE: This is the only tool that requires synchronous response (not fire-and-forget)
 * because the agent needs the data to make decisions.
 */
export class QueryLeaderboardHandler extends BaseToolHandler {
  readonly name = "query_leaderboard";

  readonly schema: ToolSchema = {
    name: "query_leaderboard",
    description:
      "Get the current competition leaderboard. Use this before selecting a model approach to see what's working well.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `Number of top entries to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
          minimum: MIN_LIMIT,
          maximum: MAX_LIMIT,
        },
      },
    },
  };

  constructor(private readonly leaderboardService: ILeaderboardService) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { limit } = (args ?? {}) as QueryLeaderboardArgs;

    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isInteger(limit)) {
        throw new Error(`Invalid limit: "${limit}". Must be an integer.`);
      }
      if (limit < MIN_LIMIT || limit > MAX_LIMIT) {
        throw new Error(`Limit out of range: ${limit}. Must be ${MIN_LIMIT}-${MAX_LIMIT}.`);
      }
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { limit = DEFAULT_LIMIT } = (args ?? {}) as QueryLeaderboardArgs;

    const entries = await this.leaderboardService.getTop(context.runId, limit);

    if (entries.length === 0) {
      return "Leaderboard is empty. No experiments have been registered yet.";
    }

    const formatted = this.formatLeaderboard(entries);
    return `Top ${entries.length} experiments:\n${formatted}`;
  }

  private formatLeaderboard(entries: LeaderboardEntry[]): string {
    return entries
      .map((e, i) => {
        const rank = i + 1;
        const gap = (e.trainMean - e.cvMean).toFixed(4);
        return `${rank}. ${e.modelType} (${e.agentName}) — CV: ${e.cvMean.toFixed(4)}, Train: ${e.trainMean.toFixed(4)}, Gap: ${gap}, R${e.roundNumber}`;
      })
      .join("\n");
  }
}

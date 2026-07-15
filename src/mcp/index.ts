// ══════════════════════════════════════════════════════════════════════
// MCP Server Entry Point — formiga-agent-tools
// ══════════════════════════════════════════════════════════════════════

export { McpServer } from "./server.js";
export type {
  IToolHandler,
  IBackgroundQueue,
  IArtifactService,
  ILeaderboardService,
  ToolSchema,
  ToolResult,
  ToolContext,
  ArtifactInput,
  LeaderboardEntry,
  DecisionType,
} from "./types.js";

export { BackgroundQueue } from "./queue/background-queue.js";
export { BaseToolHandler } from "./tools/base-handler.js";
export {
  SaveArtifactHandler,
  LogDecisionHandler,
  ReportMetricHandler,
  QueryLeaderboardHandler,
} from "./tools/index.js";
export { ArtifactService, LeaderboardService } from "./services/index.js";

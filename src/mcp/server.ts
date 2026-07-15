// ══════════════════════════════════════════════════════════════════════
// server.ts — MCP Server for Formiga Agent Tools
// ══════════════════════════════════════════════════════════════════════

import type {
  IToolHandler,
  IBackgroundQueue,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";
import { BackgroundQueue } from "./queue/background-queue.js";
import {
  SaveArtifactHandler,
  LogDecisionHandler,
  ReportMetricHandler,
  QueryLeaderboardHandler,
} from "./tools/index.js";
import { ArtifactService, LeaderboardService } from "./services/index.js";
import { logger } from "../lib/logger.js";

interface McpServerConfig {
  shutdownTimeoutMs?: number;
}

interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP Server that exposes tools for agent artifact registration.
 *
 * Follows the Model Context Protocol (MCP) specification.
 * Designed for non-blocking operation with fire-and-forget writes.
 */
export class McpServer {
  private readonly handlers: Map<string, IToolHandler> = new Map();
  private readonly queue: IBackgroundQueue;
  private readonly config: Required<McpServerConfig>;
  private running = false;

  constructor(config: McpServerConfig = {}) {
    this.config = {
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 5000,
    };

    this.queue = new BackgroundQueue();
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    const artifactService = new ArtifactService();
    const leaderboardService = new LeaderboardService();

    const tools: IToolHandler[] = [
      new SaveArtifactHandler(artifactService, this.queue),
      new LogDecisionHandler(artifactService, this.queue),
      new ReportMetricHandler(artifactService, this.queue),
      new QueryLeaderboardHandler(leaderboardService),
    ];

    for (const handler of tools) {
      this.handlers.set(handler.name, handler);
    }
  }

  registerTool(handler: IToolHandler): void {
    if (this.handlers.has(handler.name)) {
      logger.warn(`Overwriting existing tool handler: ${handler.name}`);
    }
    this.handlers.set(handler.name, handler);
  }

  getToolSchemas(): ToolSchema[] {
    return Array.from(this.handlers.values()).map((h) => h.schema);
  }

  async handleToolCall(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const handler = this.handlers.get(name);

    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return handler.handle(args, context);
  }

  async handleRequest(request: McpRequest): Promise<McpResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "initialize":
          return this.handleInitialize(id);

        case "tools/list":
          return this.handleToolsList(id);

        case "tools/call":
          return await this.handleToolsCall(id, params);

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("MCP request error", { method, error: msg });
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: msg },
      };
    }
  }

  private handleInitialize(id: string | number): McpResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "formiga-agent-tools",
          version: "1.0.0",
        },
      },
    };
  }

  private handleToolsList(id: string | number): McpResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: this.getToolSchemas(),
      },
    };
  }

  private async handleToolsCall(
    id: string | number,
    params?: Record<string, unknown>,
  ): Promise<McpResponse> {
    const name = params?.name as string | undefined;
    const args = params?.arguments as unknown;
    const context = this.extractContext(params);

    if (!name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing tool name" },
      };
    }

    const result = await this.handleToolCall(name, args, context);

    if (result.isError) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: result.content[0]?.text ?? "Tool execution failed",
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: result.content,
      },
    };
  }

  private extractContext(params?: Record<string, unknown>): ToolContext {
    const meta = (params?._meta as Record<string, unknown>) ?? {};
    return {
      runId: (meta.runId as string) ?? process.env.FORMIGA_RUN_ID ?? "unknown",
      stepId:
        (meta.stepId as string) ?? process.env.FORMIGA_STEP_ID ?? "unknown",
      agentId:
        (meta.agentId as string) ?? process.env.FORMIGA_AGENT_ID ?? "unknown",
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("MCP Server started", {
      tools: Array.from(this.handlers.keys()),
    });
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    logger.info("MCP Server shutting down...");
    await this.queue.shutdown(this.config.shutdownTimeoutMs);
    logger.info("MCP Server shutdown complete");
  }

  get isRunning(): boolean {
    return this.running;
  }

  get pendingTasks(): number {
    return this.queue.pending;
  }
}

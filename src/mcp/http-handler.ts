// ══════════════════════════════════════════════════════════════════════
// http-handler.ts — MCP HTTP transport built on the official SDK
// ══════════════════════════════════════════════════════════════════════
//
// This is the HTTP-facing entry point for the Formiga MCP server. It:
//   1. Instantiates an `@modelcontextprotocol/sdk` `Server` at process boot
//   2. Registers the four Formiga tools using the SDK's request handlers
//   3. Exposes `POST /mcp` (JSON-RPC) using the SDK's `StreamableHTTPServerTransport`
//
// Why the SDK (open-source, MIT — modelcontextprotocol/typescript-sdk):
//   • Owns wire-format concerns: JSON-RPC framing, capability negotiation,
//     protocol version handshakes, initialize round-trip, ping, cancelation.
//   • Streamable HTTP transport is the standard MCP transport for remote
//     servers — every conformant client (Claude Desktop, hermes,
//     inspector, cursor, etc.) speaks it out of the box.
//   • Upgrading the SDK gives us new protocol features without touching
//     handler code.
//
// Tool handlers reuse `IToolHandler` — the same interface the pi
// extension uses — so both harnesses share validation + persistence.
// One implementation, two frontends.
// ══════════════════════════════════════════════════════════════════════

import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { logger } from "../lib/logger.js";
import { BackgroundQueue } from "./queue/background-queue.js";
import { ArtifactService, LeaderboardService } from "./services/index.js";
import {
  SaveArtifactHandler,
  LogDecisionHandler,
  ReportMetricHandler,
  QueryLeaderboardHandler,
} from "./tools/index.js";
import type { IToolHandler, ToolContext } from "./types.js";

// ── Server bootstrap ─────────────────────────────────────────────────

interface BootstrappedServer {
  server: Server;
  handlers: Map<string, IToolHandler>;
  queue: BackgroundQueue;
}

let bootstrapped: BootstrappedServer | null = null;

function bootstrap(): BootstrappedServer {
  if (bootstrapped) return bootstrapped;

  const queue = new BackgroundQueue();
  const artifactService = new ArtifactService();
  const leaderboardService = new LeaderboardService();

  const handlerList: IToolHandler[] = [
    new SaveArtifactHandler(artifactService, queue),
    new LogDecisionHandler(artifactService, queue),
    new ReportMetricHandler(artifactService, queue),
    new QueryLeaderboardHandler(leaderboardService),
  ];

  const handlers = new Map(handlerList.map((h) => [h.name, h]));

  const server = new Server(
    {
      name: "formiga-agent-tools",
      version: "1.0.0",
    },
    {
      capabilities: { tools: {} },
    },
  );

  // tools/list — advertise every registered handler.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: handlerList.map((h) => ({
      name: h.schema.name,
      description: h.schema.description,
      inputSchema: h.schema.inputSchema,
    })),
  }));

  // tools/call — dispatch to the appropriate handler with per-call context.
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args, _meta } = req.params;
    const handler = handlers.get(name);

    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const context = extractContext(_meta);
    const result = await handler.handle(args, context);
    return {
      content: result.content,
      isError: result.isError ?? false,
    };
  });

  bootstrapped = { server, handlers, queue };
  logger.info("MCP HTTP server bootstrapped", {
    tools: handlerList.map((h) => h.name),
  });
  return bootstrapped;
}

function extractContext(meta: unknown): ToolContext {
  const m = (meta ?? {}) as Record<string, unknown>;
  return {
    runId: pickString(m.runId) ?? process.env.FORMIGA_RUN_ID ?? "unknown",
    stepId: pickString(m.stepId) ?? process.env.FORMIGA_STEP_ID ?? "unknown",
    agentId: pickString(m.agentId) ?? process.env.FORMIGA_AGENT_ID ?? "unknown",
  };
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ── HTTP surface ─────────────────────────────────────────────────────

/**
 * Handle an MCP request over HTTP using the SDK's official
 * `StreamableHTTPServerTransport`.
 *
 * Each request gets its own transport instance (stateless mode via
 * `sessionIdGenerator: undefined`). The SDK owns everything wire-level:
 * JSON-RPC framing, streaming responses, error mapping, session semantics.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { server } = bootstrap();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — one server per process, no session map
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("MCP HTTP handler error", { error: message });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: `Internal error: ${message}` },
        }),
      );
    }
  } finally {
    // Best-effort cleanup. The transport hangs onto its own resources
    // (open SSE streams, etc.) that we want released between requests.
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Discovery / health endpoint. Not part of the MCP spec — useful for
 * humans debugging with `curl http://localhost:3737/mcp/info`.
 */
export function handleMcpDiscovery(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const { handlers } = bootstrap();
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      server: "formiga-agent-tools",
      version: "1.0.0",
      protocolVersion: "2024-11-05",
      tools: Array.from(handlers.values()).map((h) => ({
        name: h.schema.name,
        description: h.schema.description,
      })),
    }),
  );
}

/**
 * Reset the singleton — used only in tests. Not part of the public API.
 */
export function __resetForTests(): void {
  if (bootstrapped) {
    bootstrapped.queue.shutdown(100).catch(() => {});
  }
  bootstrapped = null;
}

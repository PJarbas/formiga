// ══════════════════════════════════════════════════════════════════════
// server.test.ts — Unit tests for McpServer
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "../server.js";

vi.mock("../services/index.js", () => ({
  ArtifactService: vi.fn().mockImplementation(() => ({
    save: vi.fn().mockResolvedValue(1),
  })),
  LeaderboardService: vi.fn().mockImplementation(() => ({
    getTop: vi.fn().mockResolvedValue([]),
  })),
}));

describe("McpServer", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  describe("initialization", () => {
    it("starts in stopped state", () => {
      expect(server.isRunning).toBe(false);
    });

    it("starts when start() is called", async () => {
      await server.start();
      expect(server.isRunning).toBe(true);
    });

    it("registers default tools", () => {
      const schemas = server.getToolSchemas();

      expect(schemas.map((s) => s.name)).toContain("save_artifact");
      expect(schemas.map((s) => s.name)).toContain("log_decision");
      expect(schemas.map((s) => s.name)).toContain("report_metric");
      expect(schemas.map((s) => s.name)).toContain("query_leaderboard");
    });
  });

  describe("MCP protocol", () => {
    it("handles initialize request", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({
        protocolVersion: expect.any(String),
        capabilities: { tools: {} },
        serverInfo: {
          name: "formiga-agent-tools",
          version: "1.0.0",
        },
      });
    });

    it("handles tools/list request", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toHaveProperty("tools");

      const tools = (response.result as { tools: unknown[] }).tools;
      expect(tools.length).toBe(4);
    });

    it("handles tools/call request", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "save_artifact",
          arguments: {
            key: "test_artifact",
            data: { foo: "bar" },
          },
          _meta: {
            runId: "run-123",
            stepId: "step-456",
            agentId: "agent-789",
          },
        },
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toHaveProperty("content");
    });

    it("returns error for unknown method", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "unknown/method",
      });

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toContain("Method not found");
    });

    it("returns error for missing tool name", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          arguments: {},
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain("Missing tool name");
    });

    it("returns error for unknown tool", async () => {
      const response = await server.handleRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "nonexistent_tool",
          arguments: {},
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error?.message).toContain("Unknown tool");
    });
  });

  describe("tool handling", () => {
    it("handles tool call directly", async () => {
      const result = await server.handleToolCall(
        "save_artifact",
        { key: "test_key", data: { value: 123 } },
        { runId: "run-1", stepId: "step-1", agentId: "agent-1" },
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("queued");
    });

    it("returns error for unknown tool", async () => {
      const result = await server.handleToolCall(
        "unknown_tool",
        {},
        { runId: "run-1", stepId: "step-1", agentId: "agent-1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("validates tool arguments", async () => {
      const result = await server.handleToolCall(
        "save_artifact",
        { key: "INVALID", data: {} },
        { runId: "run-1", stepId: "step-1", agentId: "agent-1" },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });
  });

  describe("shutdown", () => {
    it("shuts down gracefully", async () => {
      await server.start();
      expect(server.isRunning).toBe(true);

      await server.shutdown();
      expect(server.isRunning).toBe(false);
    });

    it("is idempotent", async () => {
      await server.start();
      await server.shutdown();
      await server.shutdown();

      expect(server.isRunning).toBe(false);
    });
  });

  describe("pending tasks", () => {
    it("reports zero pending initially", () => {
      expect(server.pendingTasks).toBe(0);
    });
  });
});

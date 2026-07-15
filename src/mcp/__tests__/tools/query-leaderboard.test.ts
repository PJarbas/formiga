// ══════════════════════════════════════════════════════════════════════
// query-leaderboard.test.ts — Unit tests for QueryLeaderboardHandler
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryLeaderboardHandler } from "../../tools/query-leaderboard.js";
import type { ILeaderboardService, LeaderboardEntry, ToolContext } from "../../types.js";

describe("QueryLeaderboardHandler", () => {
  let handler: QueryLeaderboardHandler;
  let mockLeaderboardService: ILeaderboardService;

  const mockContext: ToolContext = {
    runId: "run-123",
    stepId: "step-456",
    agentId: "agent-789",
  };

  const mockEntries: LeaderboardEntry[] = [
    {
      modelType: "XGBoost",
      agentName: "agent-1",
      cvMean: 0.85,
      trainMean: 0.90,
      roundNumber: 3,
    },
    {
      modelType: "LightGBM",
      agentName: "agent-2",
      cvMean: 0.83,
      trainMean: 0.88,
      roundNumber: 2,
    },
    {
      modelType: "RandomForest",
      agentName: "agent-3",
      cvMean: 0.80,
      trainMean: 0.82,
      roundNumber: 1,
    },
  ];

  beforeEach(() => {
    mockLeaderboardService = {
      getTop: vi.fn().mockResolvedValue(mockEntries),
    };

    handler = new QueryLeaderboardHandler(mockLeaderboardService);
  });

  describe("schema", () => {
    it("has correct name", () => {
      expect(handler.name).toBe("query_leaderboard");
    });

    it("has optional limit parameter", () => {
      const props = handler.schema.inputSchema.properties as Record<string, unknown>;
      expect(props.limit).toBeDefined();
      expect(handler.schema.inputSchema.required).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("accepts no arguments", async () => {
      const result = await handler.handle({}, mockContext);
      expect(result.isError).toBeUndefined();
    });

    it("accepts valid limit", async () => {
      const result = await handler.handle({ limit: 10 }, mockContext);
      expect(result.isError).toBeUndefined();
    });

    it("rejects non-integer limit", async () => {
      const result = await handler.handle({ limit: 5.5 }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Must be an integer");
    });

    it("rejects limit below minimum", async () => {
      const result = await handler.handle({ limit: 0 }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("out of range");
    });

    it("rejects limit above maximum", async () => {
      const result = await handler.handle({ limit: 100 }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("out of range");
    });

    it("rejects string limit", async () => {
      const result = await handler.handle({ limit: "5" }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Must be an integer");
    });
  });

  describe("execution", () => {
    it("calls leaderboard service with default limit", async () => {
      await handler.handle({}, mockContext);

      expect(mockLeaderboardService.getTop).toHaveBeenCalledWith("run-123", 5);
    });

    it("calls leaderboard service with custom limit", async () => {
      await handler.handle({ limit: 10 }, mockContext);

      expect(mockLeaderboardService.getTop).toHaveBeenCalledWith("run-123", 10);
    });

    it("formats leaderboard entries correctly", async () => {
      const result = await handler.handle({}, mockContext);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Top 3 experiments:");
      expect(result.content[0].text).toContain("XGBoost");
      expect(result.content[0].text).toContain("LightGBM");
      expect(result.content[0].text).toContain("RandomForest");
      expect(result.content[0].text).toContain("CV: 0.8500");
      expect(result.content[0].text).toContain("Train: 0.9000");
    });

    it("includes rank numbers", async () => {
      const result = await handler.handle({}, mockContext);

      expect(result.content[0].text).toContain("1. XGBoost");
      expect(result.content[0].text).toContain("2. LightGBM");
      expect(result.content[0].text).toContain("3. RandomForest");
    });

    it("includes agent name and round", async () => {
      const result = await handler.handle({}, mockContext);

      expect(result.content[0].text).toContain("(agent-1)");
      expect(result.content[0].text).toContain("R3");
    });

    it("handles empty leaderboard", async () => {
      mockLeaderboardService.getTop = vi.fn().mockResolvedValue([]);

      const result = await handler.handle({}, mockContext);

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Leaderboard is empty");
    });

    it("calculates gap correctly", async () => {
      const result = await handler.handle({}, mockContext);

      expect(result.content[0].text).toContain("Gap: 0.0500");
    });
  });
});

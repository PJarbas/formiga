// ══════════════════════════════════════════════════════════════════════
// query-arena.test.ts — Unit tests for QueryArenaHandler
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryArenaHandler } from "../../tools/query-arena.js";
import type { IArenaService, ArenaSessionView, ArenaRoundView, ConvergencePoint, ToolContext } from "../../types.js";

describe("QueryArenaHandler", () => {
  let handler: QueryArenaHandler;
  let mockArenaService: IArenaService;

  const mockContext: ToolContext = {
    runId: "run-arena-1",
    stepId: "report",
    agentId: "reporter",
  };

  const sampleSession: ArenaSessionView = {
    metricName: "auc",
    metricDirection: "higher",
    targetMetric: 0.85,
    currentRound: 3,
    maxRounds: 5,
    bestMetric: 0.812,
    bestAgent: "modeler-classic",
    baselineMetric: 0.7234,
    status: "running",
    totalKeep: 4,
    totalDiscard: 2,
    totalCrash: 0,
    consecutiveNoImprove: 1,
  };

  const sampleRounds: ArenaRoundView[] = [
    {
      round: 3,
      experiments: [
        {
          experimentId: 7,
          agentName: "modeler-classic",
          modelType: "lightgbm",
          metric: 0.812,
          decision: "keep",
          confidenceScore: 0.8,
          confidenceBand: "high",
          hypothesis: "L2 regularization",
          learned: "early stopping helped",
          durationMs: 47000,
          status: "AUDITED",
        },
      ],
    },
  ];

  const sampleConvergence: ConvergencePoint[] = [
    { round: 1, agent: "modeler-classic", metric: 0.7234, decision: "baseline", timestamp: "2026-07-25T00:00:00.000Z" },
    { round: 3, agent: "modeler-classic", metric: 0.812, decision: "keep", timestamp: "2026-07-25T00:10:00.000Z" },
  ];

  beforeEach(() => {
    mockArenaService = {
      getSession: vi.fn().mockResolvedValue(sampleSession),
      getRounds: vi.fn().mockResolvedValue(sampleRounds),
      getConvergence: vi.fn().mockResolvedValue(sampleConvergence),
    };
    handler = new QueryArenaHandler(mockArenaService);
  });

  describe("schema", () => {
    it("has correct name", () => {
      expect(handler.name).toBe("query_arena");
    });

    it("requires view", () => {
      expect(handler.schema.inputSchema.required).toContain("view");
    });

    it("restricts view to the allowlist", () => {
      const enumValues = (handler.schema.inputSchema.properties as { view: { enum: string[] } }).view.enum;
      expect(enumValues).toEqual(["session", "rounds", "convergence"]);
    });
  });

  describe("validation", () => {
    it("rejects missing view", async () => {
      const result = await handler.handle({}, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing required field: view");
    });

    it("rejects an unknown view (allowlist enforced)", async () => {
      const result = await handler.handle({ view: "winners" }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid view");
    });

    it("accepts each valid view", async () => {
      for (const view of ["session", "rounds", "convergence"]) {
        const result = await handler.handle({ view }, mockContext);
        expect(result.isError).toBeUndefined();
      }
    });
  });

  describe("session view", () => {
    it("returns the competition state", async () => {
      const result = await handler.handle({ view: "session" }, mockContext);
      expect(mockArenaService.getSession).toHaveBeenCalledWith("run-arena-1");
      const text = result.content[0].text as string;
      expect(text).toContain("auc");
      expect(text).toContain("0.812");
      expect(text).toContain("modeler-classic");
      expect(text).toContain("keep=4");
    });

    it("reports missing session", async () => {
      mockArenaService.getSession = vi.fn().mockResolvedValue(null);
      const result = await handler.handle({ view: "session" }, mockContext);
      expect(result.content[0].text).toContain("No arena session found");
    });
  });

  describe("rounds view", () => {
    it("returns experiments grouped by round", async () => {
      const result = await handler.handle({ view: "rounds" }, mockContext);
      expect(mockArenaService.getRounds).toHaveBeenCalledWith("run-arena-1");
      const text = result.content[0].text as string;
      expect(text).toContain("Round 3");
      expect(text).toContain("modeler-classic");
      expect(text).toContain("0.812000");
    });

    it("reports empty rounds", async () => {
      mockArenaService.getRounds = vi.fn().mockResolvedValue([]);
      const result = await handler.handle({ view: "rounds" }, mockContext);
      expect(result.content[0].text).toContain("No arena rounds found");
    });
  });

  describe("convergence view", () => {
    it("returns the time-ordered metric series", async () => {
      const result = await handler.handle({ view: "convergence" }, mockContext);
      expect(mockArenaService.getConvergence).toHaveBeenCalledWith("run-arena-1");
      const text = result.content[0].text as string;
      expect(text).toContain("R1 modeler-classic");
      expect(text).toContain("R3 modeler-classic");
      expect(text).toContain("Convergence series (2 points)");
    });

    it("reports empty convergence", async () => {
      mockArenaService.getConvergence = vi.fn().mockResolvedValue([]);
      const result = await handler.handle({ view: "convergence" }, mockContext);
      expect(result.content[0].text).toContain("No convergence points found");
    });
  });
});

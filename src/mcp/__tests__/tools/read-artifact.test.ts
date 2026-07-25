// ══════════════════════════════════════════════════════════════════════
// read-artifact.test.ts — Unit tests for ReadArtifactHandler
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReadArtifactHandler } from "../../tools/read-artifact.js";
import type { IArtifactService, ArtifactRecord, ToolContext } from "../../types.js";

describe("ReadArtifactHandler", () => {
  let handler: ReadArtifactHandler;
  let mockArtifactService: IArtifactService;

  const mockContext: ToolContext = {
    runId: "run-123",
    stepId: "step-456",
    agentId: "agent-789",
  };

  const sampleRecord: ArtifactRecord = {
    artifactKey: "eda_report",
    agentId: "data-analyst",
    stepId: "eda",
    content: { dataset_overview: { rows: 1000, cols: 25 } },
    contentType: "json",
    sizeBytes: 512,
    createdAt: "2026-07-25T00:00:00.000Z",
  };

  beforeEach(() => {
    mockArtifactService = {
      save: vi.fn().mockResolvedValue(1),
      getNextCounter: vi.fn().mockResolvedValue(1),
      getByKey: vi.fn().mockResolvedValue(sampleRecord),
      listByRun: vi.fn().mockResolvedValue([sampleRecord]),
    };
    handler = new ReadArtifactHandler(mockArtifactService);
  });

  describe("schema", () => {
    it("has correct name", () => {
      expect(handler.name).toBe("read_artifact");
    });

    it("does not require key (list mode)", () => {
      expect(handler.schema.inputSchema.required ?? []).not.toContain("key");
    });
  });

  describe("validation", () => {
    it("rejects invalid key format - uppercase", async () => {
      const result = await handler.handle({ key: "INVALID_KEY" }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("rejects key starting with number", async () => {
      const result = await handler.handle({ key: "1key" }, mockContext);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("accepts valid key", async () => {
      const result = await handler.handle({ key: "eda_report" }, mockContext);
      expect(result.isError).toBeUndefined();
    });

    it("accepts no key (list mode)", async () => {
      const result = await handler.handle({}, mockContext);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("read mode (with key)", () => {
    it("returns the artifact content as JSON", async () => {
      const result = await handler.handle({ key: "eda_report" }, mockContext);
      expect(mockArtifactService.getByKey).toHaveBeenCalledWith("run-123", "eda_report");
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual({ dataset_overview: { rows: 1000, cols: 25 } });
    });

    it("returns a not-found message when the artifact is missing", async () => {
      mockArtifactService.getByKey = vi.fn().mockResolvedValue(null);
      const result = await handler.handle({ key: "missing" }, mockContext);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Artifact not found: \"missing\"");
    });
  });

  describe("list mode (without key)", () => {
    it("lists artifact keys for the run", async () => {
      mockArtifactService.listByRun = vi.fn().mockResolvedValue([
        sampleRecord,
        { ...sampleRecord, artifactKey: "features_report", agentId: "feature-engineer" },
      ]);
      const result = await handler.handle({}, mockContext);
      expect(mockArtifactService.listByRun).toHaveBeenCalledWith("run-123");
      const text = result.content[0].text as string;
      expect(text).toContain("eda_report");
      expect(text).toContain("features_report");
      expect(text).toContain("Artifacts for this run (2)");
    });

    it("reports empty when no artifacts exist", async () => {
      mockArtifactService.listByRun = vi.fn().mockResolvedValue([]);
      const result = await handler.handle({}, mockContext);
      expect(result.content[0].text).toContain("No artifacts found");
    });
  });
});

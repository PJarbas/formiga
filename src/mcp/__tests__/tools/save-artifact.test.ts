// ══════════════════════════════════════════════════════════════════════
// save-artifact.test.ts — Unit tests for SaveArtifactHandler
// ══════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SaveArtifactHandler } from "../../tools/save-artifact.js";
import type { IArtifactService, IBackgroundQueue, ToolContext } from "../../types.js";

describe("SaveArtifactHandler", () => {
  let handler: SaveArtifactHandler;
  let mockArtifactService: IArtifactService;
  let mockQueue: IBackgroundQueue;
  let capturedTask: (() => Promise<void>) | null = null;

  const mockContext: ToolContext = {
    runId: "run-123",
    stepId: "step-456",
    agentId: "agent-789",
  };

  beforeEach(() => {
    capturedTask = null;

    mockArtifactService = {
      save: vi.fn().mockResolvedValue(1),
    };

    mockQueue = {
      enqueue: vi.fn((task) => {
        capturedTask = task;
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      pending: 0,
    };

    handler = new SaveArtifactHandler(mockArtifactService, mockQueue);
  });

  describe("schema", () => {
    it("has correct name", () => {
      expect(handler.name).toBe("save_artifact");
    });

    it("has required fields in schema", () => {
      expect(handler.schema.inputSchema.required).toContain("key");
      expect(handler.schema.inputSchema.required).toContain("data");
    });
  });

  describe("validation", () => {
    it("rejects missing key", async () => {
      const result = await handler.handle({ data: { foo: "bar" } }, mockContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing required field: key");
    });

    it("rejects invalid key format - uppercase", async () => {
      const result = await handler.handle(
        { key: "INVALID_KEY", data: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("rejects invalid key format - starts with number", async () => {
      const result = await handler.handle(
        { key: "123_key", data: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("rejects invalid key format - special characters", async () => {
      const result = await handler.handle(
        { key: "my-key!", data: {} },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("rejects key that is too short", async () => {
      const result = await handler.handle({ key: "a", data: {} }, mockContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid artifact key");
    });

    it("accepts valid key formats", async () => {
      const validKeys = ["eda_report", "features_v2", "model_metrics_final"];

      for (const key of validKeys) {
        const result = await handler.handle(
          { key, data: { test: true } },
          mockContext,
        );
        expect(result.isError).toBeUndefined();
      }
    });

    it("rejects missing data", async () => {
      const result = await handler.handle({ key: "valid_key" }, mockContext);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("must be a JSON object");
    });

    it("rejects non-object data", async () => {
      const result = await handler.handle(
        { key: "valid_key", data: "string" },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("must be a JSON object");
    });

    it("rejects array as data", async () => {
      const result = await handler.handle(
        { key: "valid_key", data: [1, 2, 3] },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("must be a JSON object");
    });
  });

  describe("execution", () => {
    it("enqueues task and returns immediately", async () => {
      const result = await handler.handle(
        { key: "eda_report", data: { shape: [1000, 25] } },
        mockContext,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("queued");
      expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(mockArtifactService.save).not.toHaveBeenCalled();
    });

    it("saves artifact when task is executed", async () => {
      await handler.handle(
        { key: "eda_report", data: { shape: [1000, 25] } },
        mockContext,
      );

      expect(capturedTask).not.toBeNull();
      await capturedTask!();

      expect(mockArtifactService.save).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-123",
          stepId: "step-456",
          agentId: "agent-789",
          artifactKey: "eda_report",
          contentType: "json",
        }),
      );
    });

    it("includes content in saved artifact", async () => {
      const testData = { dataset_overview: { rows: 1000, cols: 25 } };

      await handler.handle(
        { key: "eda_report", data: testData },
        mockContext,
      );

      await capturedTask!();

      expect(mockArtifactService.save).toHaveBeenCalledWith(
        expect.objectContaining({
          content: testData,
        }),
      );
    });
  });
});
